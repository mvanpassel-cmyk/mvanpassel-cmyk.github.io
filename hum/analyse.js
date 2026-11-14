"use strict";
/* Hum: from a mono recording to notes.
   1. pitchTrack   several pitch candidates per frame (YIN), then the smoothest believable path through them
   2. toNotes      the path snapped to the singer's own semitone grid, so vibrato and slides do not become notes
   Works in the browser and in Node (for tests). */
(function (root) {
  const median = a => { const s = Array.from(a).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
  function halve(x) { const o = new Float32Array(x.length >> 1); for (let i = 0; i < o.length; i++) o[i] = 0.5 * (x[2 * i] + x[2 * i + 1]); return o; }
  function frameSetup(sr) { const tauMax = Math.floor(sr / 70), W = Math.floor(tauMax * 1.75); return { W, tauMax, tauMin: Math.max(4, Math.floor(sr / 4200)), size: W + tauMax + 1, d: new Float32Array(tauMax + 2) }; }

  // YIN difference function, cumulative-mean normalised, into d[0..tauMax].
  function yinCurve(x, W, tauMax, d) {
    let run = 0; d[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) { let s = 0; for (let j = 0; j < W; j++) { const v = x[j] - x[j + tau]; s += v * v; } run += s; d[tau] = run ? s * tau / run : 1; }
  }
  // Single best pitch of one frame (used for the live read-out while recording). 0 = none.
  function yin(x, sr, W, tauMin, tauMax, d) {
    yinCurve(x, W, tauMax, d); let best = 0, bestV = 1e9;
    for (let tau = tauMin; tau < tauMax; tau++) { if (d[tau] < 0.12) { while (tau + 1 < tauMax && d[tau + 1] < d[tau]) tau++; best = tau; bestV = d[tau]; break; } if (d[tau] < bestV) { bestV = d[tau]; best = tau; } }
    if (!best || bestV > 0.3 || best <= tauMin || best >= tauMax - 1) return 0;
    const a = d[best - 1], b = d[best], c = d[best + 1], den = a - 2 * b + c;
    return sr / (best + (den ? 0.5 * (a - c) / den : 0));
  }

  const HOP = 0.01, MAXC = 6;
  const P = { near: 0.1, sub: 0.25, voicedBias: 0.0, unvoiced: 0.55, quiet: 0.03, jump: 0.035, jumpCap: 0.5, onoff: 0.14, gate: 0.025 };

  function pitchTrack(pcm, sr) {
    while (sr > 30000) { pcm = halve(pcm); sr /= 2; }
    const F = frameSetup(sr), hop = Math.round(sr * HOP), n = Math.max(0, Math.floor((pcm.length - F.size) / hop));
    const rms = new Float32Array(n), cm = new Float32Array(n * MAXC), cv = new Float32Array(n * MAXC), cn = new Uint8Array(n);
    let peak = 0;
    for (let i = 0; i < n; i++) { let s = 0; const o = i * hop; for (let j = 0; j < F.W; j += 2) s += pcm[o + j] * pcm[o + j]; rms[i] = Math.sqrt(2 * s / F.W); if (rms[i] > peak) peak = rms[i]; }
    const gate = Math.max(0.002, peak * P.gate), d = F.d;
    for (let i = 0; i < n; i++) {
      if (rms[i] < gate) continue;
      yinCurve(pcm.subarray(i * hop, i * hop + F.size), F.W, F.tauMax, d);
      // every dip of the curve is a possible period; keep the deepest few
      const found = [];
      for (let tau = F.tauMin + 1; tau < F.tauMax - 1; tau++) if (d[tau] < 0.6 && d[tau] <= d[tau - 1] && d[tau] < d[tau + 1]) { const a = d[tau - 1], b = d[tau], c = d[tau + 1], den = a - 2 * b + c, off = den ? 0.5 * (a - c) / den : 0; found.push([69 + 12 * Math.log2(sr / (tau + off) / 440), b]); }
      // A pure tone repeats at every multiple of its period, so all those dips are equally deep. The true period is the
      // shortest of the good ones: longer candidates pay a little for every octave they sit below it.
      if (found.length) { let dm = 1e9; for (const c of found) if (c[1] < dm) dm = c[1]; let top = -1e9; for (const c of found) if (c[1] < dm + P.near && c[0] > top) top = c[0]; for (const c of found) if (c[0] < top) c[1] += P.sub * (top - c[0]) / 12; }
      found.sort((a, b) => a[1] - b[1]); const k = Math.min(MAXC, found.length); cn[i] = k;
      for (let j = 0; j < k; j++) { cm[i * MAXC + j] = found[j][0]; cv[i * MAXC + j] = found[j][1]; }
    }
    // Viterbi: state 0..k-1 = candidate, state MAXC = no pitch
    const S = MAXC + 1, cost = new Float32Array(n * S).fill(1e9), back = new Int8Array(n * S);
    for (let i = 0; i < n; i++) {
      const loud = rms[i] >= gate, uCost = loud ? P.unvoiced : P.quiet;
      for (let s = 0; s < S; s++) {
        const voiced = s < MAXC; if (voiced && s >= cn[i]) continue;
        // a lower pitch that fits is slightly preferred over its octave above, never the other way round
        const e = voiced ? cv[i * MAXC + s] + P.voicedBias : uCost;
        if (!i) { cost[s] = e; continue; }
        let best = 1e9, bi = S - 1;
        for (let q = 0; q < S; q++) { const pc = cost[(i - 1) * S + q]; if (pc >= 1e9) continue; const qv = q < MAXC; let t;
          if (voiced && qv) { const dj = Math.abs(cm[i * MAXC + s] - cm[(i - 1) * MAXC + q]); t = Math.min(P.jumpCap, dj * P.jump); } else t = voiced === qv ? 0 : P.onoff;
          if (pc + t < best) { best = pc + t; bi = q; } }
        cost[i * S + s] = best + e; back[i * S + s] = bi;
      }
    }
    const f0 = new Float32Array(n);
    if (n) { let s = 0, b = 1e9; for (let q = 0; q < S; q++) if (cost[(n - 1) * S + q] < b) { b = cost[(n - 1) * S + q]; s = q; }
      for (let i = n - 1; i >= 0; i--) { f0[i] = s < MAXC ? cm[i * MAXC + s] : 0; s = back[i * S + s]; } }
    return { f0, rms, n, dt: hop / sr, dur: pcm.length / sr };
  }

  const N = { change: 7, minNote: 0.1, scoop: 0.15, bridge: 4, dip: 0.5, minPiece: 0.08 };

  function toNotes(tr) {
    const { n, dt, rms } = tr, f0 = Float32Array.from(tr.f0);
    // bridge very short dropouts inside a held pitch
    for (let i = 1; i < n; i++) if (!f0[i] && f0[i - 1]) { let j = i; while (j < n && !f0[j]) j++; if (j < n && j - i <= N.bridge && Math.abs(f0[j] - f0[i - 1]) < 1.2) for (let k = i; k < j; k++) f0[k] = f0[i - 1] + (f0[j] - f0[i - 1]) * (k - i + 1) / (j - i + 1); i = j; }
    // how far this singer sits from concert pitch: only frames where the pitch is steady count
    let x = 0, y = 0;
    for (let i = 2; i < n - 2; i++) if (f0[i] && f0[i - 2] && f0[i + 2] && Math.abs(f0[i + 2] - f0[i - 2]) < 0.25) { const a = (f0[i] - Math.round(f0[i])) * 2 * Math.PI; x += Math.cos(a); y += Math.sin(a); }
    const tune = x || y ? Math.atan2(y, x) / (2 * Math.PI) : 0;
    const env = new Float32Array(n); for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let k = Math.max(0, i - 1); k <= Math.min(n - 1, i + 1); k++) { s += rms[k]; c++; } env[i] = s / c; }
    const notes = [];
    for (let a = 0; a < n; a++) {
      if (!f0[a]) continue; let z = a; while (z < n && f0[z]) z++;
      // one voiced stretch a..z: cheapest staircase of semitones, where every step costs N.change
      let lo = 200, hi = -200; for (let i = a; i < z; i++) { const v = f0[i] - tune; if (v < lo) lo = v; if (v > hi) hi = v; }
      lo = Math.floor(lo) - 1; hi = Math.ceil(hi) + 1; const K = hi - lo + 1, len = z - a, c = new Float32Array(len * K), bk = new Int16Array(len * K);
      for (let i = 0; i < len; i++) { const v = f0[a + i] - tune; let pm = 1e9, pk = 0; if (i) for (let k = 0; k < K; k++) if (c[(i - 1) * K + k] < pm) { pm = c[(i - 1) * K + k]; pk = k; }
        for (let k = 0; k < K; k++) { const e = Math.min(2.5, Math.abs(v - (lo + k))); let best = e * e, from = k; if (i) { const stay = c[(i - 1) * K + k]; if (stay <= pm + N.change) best += stay; else { best += pm + N.change; from = pk; } } c[i * K + k] = best; bk[i * K + k] = from; } }
      const st = new Int16Array(len); let k = 0, b = 1e9; for (let q = 0; q < K; q++) if (c[(len - 1) * K + q] < b) { b = c[(len - 1) * K + q]; k = q; }
      for (let i = len - 1; i >= 0; i--) { st[i] = k; k = bk[i * K + k]; }
      let runs = []; for (let i = 0; i < len; i++) { const r = runs[runs.length - 1]; if (r && r.s === st[i]) r.z = a + i + 1; else runs.push({ a: a + i, z: a + i + 1, s: st[i] }); }
      // a step too short to be a note is a slide: give it to the neighbour closest in pitch
      for (let guard = 0; guard < 50; guard++) { const i = runs.findIndex(r => (r.z - r.a) * dt < N.minNote); if (i < 0 || runs.length === 1) break; const r = runs[i], L = runs[i - 1], R = runs[i + 1], toL = L && (!R || Math.abs(L.s - r.s) <= Math.abs(R.s - r.s)); if (toL) L.z = r.z; else R.a = r.a; runs.splice(i, 1);
        for (let j = runs.length - 1; j > 0; j--) if (runs[j].s === runs[j - 1].s) { runs[j - 1].z = runs[j].z; runs.splice(j, 1); } }
      // sliding into the first note of a phrase, or falling off the last one, is not a note either
      if (runs.length > 1) { const A = runs[0], B = runs[1]; if ((A.z - A.a) * dt < N.scoop && (B.z - B.a) > 2 * (A.z - A.a) && Math.abs(A.s - B.s) <= 3) { B.a = A.a; runs.shift(); } }
      if (runs.length > 1) { const Z = runs[runs.length - 1], Y = runs[runs.length - 2]; if ((Z.z - Z.a) * dt < N.scoop && (Y.z - Y.a) > 2 * (Z.z - Z.a) && Math.abs(Z.s - Y.s) <= 3) { Y.z = Z.z; runs.pop(); } }
      // the same pitch sung twice: a clear dip in loudness between two swells
      const pieces = [];
      for (const r of runs) { let start = r.a; const minF = Math.round(N.minPiece / dt);
        for (let i = r.a + minF; i < r.z - minF; i++) { if (!(env[i] <= env[i - 1] && env[i] < env[i + 1])) continue; let pl = 0, pr = 0; for (let q = start; q < i; q++) if (env[q] > pl) pl = env[q]; for (let q = i + 1; q < r.z; q++) if (env[q] > pr) pr = env[q];
          if (env[i] < N.dip * Math.min(pl, pr) && i - start >= minF) { pieces.push({ a: start, z: i, s: r.s }); start = i; } }
        pieces.push({ a: start, z: r.z, s: r.s }); }
      for (const r of pieces) { if ((r.z - r.a) * dt < N.minNote) continue; const mid = []; const q0 = r.a + Math.floor((r.z - r.a) * 0.2), q1 = r.z - Math.floor((r.z - r.a) * 0.2); for (let i = q0; i < Math.max(q1, q0 + 1); i++) mid.push(tr.f0[i] || f0[i]);
        notes.push({ t: r.a * dt, d: (r.z - r.a) * dt, m: lo + r.s + tune, raw: median(mid) }); }
      a = z;
    }
    const trace = []; for (let i = 0; i < n; i += 2) if (tr.f0[i]) trace.push([+(i * dt).toFixed(3), +tr.f0[i].toFixed(2)]);
    const t0 = notes.length ? notes[0].t : 0;
    notes.forEach(o => { o.t = +(o.t - t0).toFixed(3); o.d = +o.d.toFixed(3); o.m = +o.m.toFixed(2); o.raw = +o.raw.toFixed(2); });
    return { notes, trace: trace.map(([t, v]) => [+(t - t0).toFixed(3), v]), t0, dur: tr.dur, tune };
  }

  function analyse(pcm, sr) { return toNotes(pitchTrack(pcm, sr)); }
  root.HumAnalyse = { analyse, pitchTrack, toNotes, yin, halve, frameSetup, P, N, HOP };
})(typeof window !== "undefined" ? window : globalThis);
if (typeof module !== "undefined") module.exports = globalThis.HumAnalyse;
