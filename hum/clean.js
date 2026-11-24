"use strict";
/* Hum: clean-up engine shared with SlowReverb Studio (same code, tested there).
   Used here to tidy a take before the notes are worked out: rumble filter and a light,
   steady-noise-only spectral noise reduction (it leaves the voice alone when there is no
   steady hiss/hum/fan noise to remove), plus a transparent look-ahead limiter.
   Works in the browser and in Node (for tests). */
/* ═══ DSP engine ════════════════════════════════════════════════════════════
   Pure number crunching, no DOM. Runs inside a Web Worker (the same source is
   loaded into a Blob worker) and falls back to the main thread if needed.
   DSP.clean(...)  : rumble filter, de-click, spectral noise reduction, leveller, silence trim
   DSP.loops(...)  : beat-synchronous self-similarity → ranked seamless loop candidates */
var DSP = (function () {
  'use strict';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fftCache = {};
  function getFFT(n) {
    if (fftCache[n]) return fftCache[n];
    const bits = Math.round(Math.log2(n)), cs = new Float64Array(n / 2), sn = new Float64Array(n / 2), rev = new Uint32Array(n);
    for (let i = 0; i < n / 2; i++) { cs[i] = Math.cos(2 * Math.PI * i / n); sn[i] = Math.sin(2 * Math.PI * i / n); }
    for (let i = 0; i < n; i++) { let r = 0, v = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (v & 1); v >>= 1; } rev[i] = r; }
    const f = (re, im, inv) => {
      for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      const sg = inv ? 1 : -1;
      for (let size = 2; size <= n; size <<= 1) {
        const h = size >> 1, st = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = 0, k = 0; j < h; j++, k += st) {
            const a = i + j, b = a + h, c = cs[k], s = sg * sn[k];
            const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          }
        }
      }
      if (inv) { const k = 1 / n; for (let i = 0; i < n; i++) { re[i] *= k; im[i] *= k; } }
    };
    return (fftCache[n] = f);
  }
  function pct(arr, p) {
    if (!arr.length) return -120;
    const a = Float64Array.from(arr).sort();
    return a[clamp(Math.floor(p * a.length), 0, a.length - 1)];
  }
  function frameDb(chans, sr, win) {
    const n = chans[0].length, W = Math.max(64, Math.round(sr * win)), out = [];
    for (let i = 0; i + W <= n; i += W) {
      let s = 0;
      for (const c of chans) for (let j = i; j < i + W; j++) s += c[j] * c[j];
      s /= W * chans.length;
      if (s > 1e-15) out.push(10 * Math.log10(s));
    }
    return out;
  }
  const noiseFloor = (chans, sr) => pct(frameDb(chans, sr, 0.05), 0.1);

  // 2nd-order Butterworth high-pass, run forward + backward (zero phase, no smearing of transients)
  function hp(x, f, sr) {
    const w = 2 * Math.PI * f / sr, cw = Math.cos(w), al = Math.sin(w) * Math.SQRT1_2, a0 = 1 + al;
    const b0 = (1 + cw) / 2 / a0, b1 = -(1 + cw) / a0, b2 = b0, a1 = -2 * cw / a0, a2 = (1 - al) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) { const v = x[i], y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = y; x[i] = y; }
  }
  function lowCut(x, f, sr) {
    let m = 0; for (let i = 0; i < x.length; i++) m += x[i]; m /= x.length || 1;
    for (let i = 0; i < x.length; i++) x[i] -= m;
    hp(x, f, sr); x.reverse(); hp(x, f, sr); x.reverse();
  }

  /* Short impulsive clicks: a spike in the 2nd difference, ≤1.5 ms long, far above the texture
     just before it, AND the texture right after it is back to normal. That last test is what
     separates a click from a drum or hi-hat attack (whose energy carries on after the onset). */
  function declick(chans, sr, strength) {
    const W = Math.round(sr * 0.01), W3 = Math.round(sr * 0.003), maxLen = Math.round(sr * 0.0015), gap = Math.round(sr * 0.0006);
    const T = [14, 11, 9][strength];
    let most = 0;
    for (const x of chans) {
      const n = x.length; if (n < W * 4) continue;
      const d = new Float32Array(n);
      for (let i = 2; i < n; i++) d[i] = Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]);
      const ps = new Float64Array(n + 1); for (let i = 0; i < n; i++) ps[i + 1] = ps[i] + d[i];
      const mean = (a, b) => (ps[b] - ps[a]) / Math.max(1, b - a);
      let count = 0;
      for (let i = W + 2; i < n - W; i++) {
        const pre = mean(i - W, i - 2) + 1e-6;
        if (!(d[i] > 0.015 && d[i] > T * pre)) continue;
        let b = i;
        for (let j = i + 1; j < n && j - b <= gap; j++) if (d[j] > T * 0.5 * pre) b = j;
        const post = mean(b + gap, Math.min(n, b + gap + W3));
        if (b - i <= maxLen && post < 2.5 * pre) {
          const p0 = Math.max(1, i - 4), p1 = Math.min(n - 2, b + 4), L = p1 - p0;
          const y0 = x[p0], y1 = x[p1], m0 = (x[p0] - x[p0 - 1]) * L, m1 = (x[p1 + 1] - x[p1]) * L;
          for (let k = 1; k < L; k++) {
            const t = k / L, t2 = t * t, t3 = t2 * t;
            x[p0 + k] = (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * m1;
          }
          for (let k = p0; k <= p1 + 1 && k < n; k++) d[k] = k >= 2 ? Math.abs(x[k] - 2 * x[k - 1] + x[k - 2]) : 0;
          count++;
        }
        i = b + gap;
      }
      most = Math.max(most, count);
    }
    return most;
  }

  /* Spectral noise reduction. Pass 1 learns a per-frequency noise profile (a low percentile of
     smoothed power over time — hiss, hum and fan noise are steady, music is not). Pass 2 applies a
     decision-directed Wiener gain (Ephraim–Malah style) with a gain floor, so the result stays
     natural instead of "underwater" with musical-noise chirps. Stereo channels share one complex
     FFT (L = real, R = imaginary) and the same gain, which keeps the stereo image intact. */
  function denoise(chans, sr, strength, prog) {
    const N = sr > 32000 ? 2048 : 1024, H = N >> 2, half = N >> 1;
    const fft = getFFT(N), win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    const len = chans[0].length, stereo = chans.length > 1, padLen = len + 2 * N;
    const pL = new Float32Array(padLen); pL.set(chans[0], N);
    const pR = stereo ? new Float32Array(padLen) : null; if (stereo) pR.set(chans[1], N);
    const re = new Float64Array(N), im = new Float64Array(N), P = new Float64Array(half + 1);
    const spectrum = start => {
      for (let i = 0; i < N; i++) { const w = win[i]; re[i] = pL[start + i] * w; im[i] = stereo ? pR[start + i] * w : 0; }
      fft(re, im, false);
      let tot = 0;
      for (let k = 0; k <= half; k++) {
        const k2 = (N - k) % N;
        P[k] = (re[k] * re[k] + im[k] * im[k] + re[k2] * re[k2] + im[k2] * im[k2]) * 0.5; tot += P[k];
      }
      return tot;
    };
    // ── pass 1: noise profile via per-bin dB histograms ──
    const DBMIN = -220, STEP = 0.5, NBIN = 640, hist = new Uint32Array((half + 1) * NBIN);
    const p1 = new Float64Array(half + 1), p2 = new Float64Array(half + 1), sig = new Float64Array(half + 1);
    const totals = []; let frames1 = 0;
    const hop1 = N >> 1, last = padLen - N;
    for (let s = 0, fi = 0; s <= last; s += hop1, fi++) {
      const tot = spectrum(s);
      if (tot < 1e-18) { continue; }
      totals.push(tot); frames1++;
      for (let k = 0; k <= half; k++) {
        const a = P[Math.max(0, k - 1)], b = P[Math.min(half, k + 1)];
        const sm = ((a + 2 * P[k] + b) / 4 + p1[k] + p2[k]) / 3;
        p2[k] = p1[k]; p1[k] = (a + 2 * P[k] + b) / 4;
        sig[k] += P[k];
        const db = 10 * Math.log10(sm + 1e-30), bi = clamp(Math.round((db - DBMIN) / STEP), 0, NBIN - 1);
        hist[k * NBIN + bi]++;
      }
      if (fi % 400 === 0) prog(0.3 * s / last);
    }
    if (!frames1) return { found: false };
    const binPct = (k, q) => {
      const target = Math.max(1, Math.floor(frames1 * q)); let acc = 0, bi = 0;
      for (; bi < NBIN; bi++) { acc += hist[k * NBIN + bi]; if (acc >= target) break; }
      return DBMIN + bi * STEP;
    };
    // Per-bin confidence: only frequencies whose floor is steady (10th ≈ 30th percentile) count as
    // noise. Bands where the floor is really quiet music get no reduction at all.
    const Nk = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) {
      const p10 = binPct(k, 0.1), conf = clamp(1 - (binPct(k, 0.3) - p10 - 5) / 5, 0, 1);
      Nk[k] = Math.pow(10, p10 / 10) * 1.65 * conf;
    }
    /* Is there a *steady* noise floor? Steady hiss/hum sits at nearly the same level whenever the
       music pauses, so the 10th and 30th percentile are close (a few dB). In dense music without
       noise, the "quietest moments" are just quiet music and the spread is large — then we leave
       it alone instead of eating detail. Judged where hiss is audible: 2.5–12 kHz. */
    const spreads = [];
    for (let k = Math.ceil(2500 * N / sr); k <= Math.min(half, Math.floor(12000 * N / sr)); k++) spreads.push(binPct(k, 0.3) - binPct(k, 0.1));
    const spread = spreads.length ? pct(spreads, 0.5) : 99;
    let nSum = 0; for (let k = 0; k <= half; k++) nSum += Nk[k];   // (confidence-weighted)
    const snr = 10 * Math.log10(pct(totals, 0.8) / (nSum + 1e-30));   // loud parts vs noise profile
    const C = stereo ? 2 : 1, noiseDb = 10 * Math.log10(2 * nSum / 1.65 / (N * N / 2) / C + 1e-30);
    if (noiseDb < -80) return { found: false, clean: true, noiseDb };          // floor too low to hear
    if (spread > 10 || snr < 4) return { found: false, dense: true, spread };
    let alpha = [1.0, 1.6, 2.4][strength], floorDb = [-9, -15, -22][strength], gentle = false;
    if (spread > 6) { alpha = Math.min(alpha, 1.0); floorDb = Math.max(floorDb, -8); gentle = true; }
    const gFloor = Math.pow(10, floorDb / 20), aDD = 0.94;
    // ── pass 2: filter ──
    const oL = new Float32Array(padLen), oR = stereo ? new Float32Array(padLen) : null;
    const Gp = new Float64Array(half + 1).fill(1), gamP = new Float64Array(half + 1).fill(1), G = new Float64Array(half + 1), Gs = new Float64Array(half + 1);
    const gAcc = new Float64Array(half + 1), gCnt = new Float64Array(half + 1);
    for (let s = 0, fi = 0; s <= last; s += H, fi++) {
      spectrum(s);
      for (let k = 0; k <= half; k++) {
        const nn = alpha * Nk[k] + 1e-30, gam = P[k] / nn;
        const xi = aDD * Gp[k] * Gp[k] * gamP[k] + (1 - aDD) * Math.max(gam - 1, 0);
        G[k] = Math.max(gFloor, xi / (1 + xi)); gamP[k] = gam;
      }
      for (let k = 0; k <= half; k++) {
        Gs[k] = Math.max(gFloor, (G[Math.max(0, k - 1)] + 2 * G[k] + G[Math.min(half, k + 1)]) / 4);
        Gp[k] = G[k];
        if (P[k] < 2.5 * Nk[k]) { gAcc[k] += Gs[k] * Gs[k]; gCnt[k]++; }
      }
      for (let k = 0; k <= half; k++) {
        const g = Gs[k]; re[k] *= g; im[k] *= g;
        if (k > 0 && k < half) { re[N - k] *= g; im[N - k] *= g; }
      }
      fft(re, im, true);
      for (let i = 0; i < N; i++) { const w = win[i] * 0.5; oL[s + i] += re[i] * w; if (stereo) oR[s + i] += im[i] * w; }
      if (fi % 300 === 0) prog(0.3 + 0.7 * s / last);
    }
    chans[0].set(oL.subarray(N, N + len)); if (stereo) chans[1].set(oR.subarray(N, N + len));
    // spectrum for the UI: 72 log-spaced bands
    const spec = { sig: [], before: [], after: [] }, fLo = 40, fHi = Math.min(16000, sr / 2 * 0.95), NBANDS = 72;
    for (let b = 0; b < NBANDS; b++) {
      const k0 = Math.max(1, Math.floor(fLo * Math.pow(fHi / fLo, b / NBANDS) * N / sr)), k1 = Math.max(k0 + 1, Math.floor(fLo * Math.pow(fHi / fLo, (b + 1) / NBANDS) * N / sr));
      let a = 0, nb = 0, na = 0, c = 0;
      for (let k = k0; k < k1 && k <= half; k++) { a += sig[k] / frames1; nb += Nk[k] / 1.65; na += (Nk[k] / 1.65) * (gCnt[k] ? gAcc[k] / gCnt[k] : 1); c++; }
      c = c || 1;
      spec.sig.push(10 * Math.log10(a / c + 1e-30)); spec.before.push(10 * Math.log10(nb / c + 1e-30)); spec.after.push(10 * Math.log10(na / c + 1e-30));
    }
    return { found: true, gentle, snr, spread, spec };
  }

  // Look-ahead peak limiter: min-filter + box smoothing guarantees no overs, release keeps it musical.
  function limiter(chans, sr, ceil) {
    const n = chans[0].length, L = Math.max(1, Math.round(sr * 0.0025)), req = new Float32Array(n);
    let any = false;
    for (let i = 0; i < n; i++) { let p = 0; for (const c of chans) { const a = Math.abs(c[i]); if (a > p) p = a; } req[i] = p > ceil ? ceil / p : 1; if (p > ceil) any = true; }
    if (!any) return;
    const mn = new Float32Array(n), dq = new Int32Array(n); let h = 0, t = 0;
    for (let j = 0; j < n + L; j++) {
      if (j < n) { while (t > h && req[dq[t - 1]] >= req[j]) t--; dq[t++] = j; }
      const i = j - L; if (i < 0) continue;
      while (dq[h] < i - L) h++;
      mn[i] = req[dq[h]];
    }
    const ps = new Float64Array(n + 1); for (let i = 0; i < n; i++) ps[i + 1] = ps[i] + mn[i];
    const rel = Math.exp(-1 / (sr * 0.08)); let g = 1;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - L), b = Math.min(n, i + L + 1), avg = (ps[b] - ps[a]) / (b - a);
      g = avg < g ? avg : rel * g + (1 - rel) * avg;
      for (const c of chans) c[i] = clamp(c[i] * g, -1, 1);
    }
  }
  function loudness(chans, sr) {   // gated, BS.1770-style (without K-weighting)
    const n = chans[0].length, W = Math.min(n, Math.round(sr * 0.4)), Hh = Math.max(1, Math.round(sr * 0.1)), bl = [];
    for (let i = 0; i + W <= n; i += Hh) { let s = 0; for (const c of chans) for (let j = i; j < i + W; j++) s += c[j] * c[j]; bl.push(s / (W * chans.length)); }
    const g1 = bl.filter(v => v > 1e-7); if (!g1.length) return -70;
    const m1 = g1.reduce((a, b) => a + b, 0) / g1.length, g2 = g1.filter(v => v > m1 * 0.1);
    return 10 * Math.log10(g2.reduce((a, b) => a + b, 0) / g2.length);
  }
  // Gentle 2:1 soft-knee compression around the music's own level, then bring up to ~−16 dB RMS, peaks at −1 dB.
  function level(chans, sr) {
    const n = chans[0].length, C = chans.length, blocks = frameDb(chans, sr, 0.05);
    if (blocks.length < 4) return 0;
    const top = pct(blocks, 0.95), act = blocks.filter(v => v > Math.max(-70, top - 35));
    const thr = pct(act.length ? act : blocks, 0.6), ratio = 2, knee = 8, K = 16;
    const attK = Math.exp(-K / (sr * 0.01)), relK = Math.exp(-K / (sr * 0.3));
    let env = Math.pow(10, thr / 10), gPrev = 1;
    for (let i = 0; i < n; i += K) {
      const e = Math.min(n, i + K); let s = 0;
      for (let c = 0; c < C; c++) { const ch = chans[c]; for (let j = i; j < e; j++) s += ch[j] * ch[j]; }
      s /= C * (e - i);
      const a = s > env ? attK : relK; env = a * env + (1 - a) * s;
      const over = 10 * Math.log10(env + 1e-14) - thr;
      let red = 0;
      if (over >= knee / 2) red = over * (1 - 1 / ratio);
      else if (over > -knee / 2) { const q = over + knee / 2; red = (1 - 1 / ratio) * q * q / (2 * knee); }
      const g = Math.pow(10, -red / 20);
      for (let j = i; j < e; j++) { const gg = gPrev + (g - gPrev) * (j - i + 1) / (e - i); for (let c = 0; c < C; c++) chans[c][j] *= gg; }
      gPrev = g;
    }
    const gainDb = clamp(-16 - loudness(chans, sr), 0, 24), gl = Math.pow(10, gainDb / 20);
    for (const c of chans) for (let i = 0; i < n; i++) c[i] *= gl;
    limiter(chans, sr, Math.pow(10, -1 / 20));
    return gainDb;
  }
  function trimSilence(chans, sr) {
    const n = chans[0].length, W = Math.max(32, Math.round(sr * 0.01)), blocks = frameDb(chans, sr, 0.05);
    const thrDb = Math.min(Math.max(pct(blocks, 0.1) + 8, -62), pct(blocks, 0.9) - 30), thr = Math.pow(10, thrDb / 20);
    const F = Math.floor(n / W), thr2 = thr * thr; let first = -1, lastF = -1;
    for (let f = 0; f < F; f++) {
      let p = 0; for (const c of chans) for (let j = f * W; j < f * W + W; j++) p += c[j] * c[j];
      if (p / (W * chans.length) > thr2) { if (first < 0) first = f; lastF = f; }
    }
    if (first < 0) return { chans, start: 0, endCut: 0 };
    let start = Math.max(0, first * W - Math.round(sr * 0.06)), end = Math.min(n, (lastF + 1) * W + Math.round(sr * 0.25));
    if (start < sr * 0.05) start = 0; if (n - end < sr * 0.05) end = n;
    if (start === 0 && end === n) return { chans, start: 0, endCut: 0 };
    const out = chans.map(c => c.slice(start, end));
    const fi = start > 0 ? Math.round(sr * 0.01) : 0, fo = end < n ? Math.round(sr * 0.04) : 0, m = end - start;
    for (const c of out) {
      for (let i = 0; i < fi && i < m; i++) c[i] *= i / fi;
      for (let i = 0; i < fo && i < m; i++) c[m - 1 - i] *= i / fo;
    }
    return { chans: out, start, endCut: n - end };
  }
  function clean(payload, prog) {
    const { sr, opts } = payload; let chans = payload.chans; const st = opts.strength, rep = { opts };
    rep.noiseBefore = noiseFloor(chans, sr);
    rep.lowCut = opts.rumble ? [40, 60, 80][st] : 15;
    for (const c of chans) lowCut(c, rep.lowCut, sr);
    prog(0.05);
    if (opts.clicks) rep.clicks = declick(chans, sr, st);
    prog(0.1);
    if (opts.hiss) {
      if (rep.noiseBefore < -84) rep.hiss = { found: false, clean: true };
      else rep.hiss = denoise(chans, sr, st, f => prog(0.1 + 0.75 * f));
    }
    rep.noiseMid = noiseFloor(chans, sr);
    prog(0.88);
    if (opts.level) rep.gainDb = level(chans, sr);
    else { let pk = 0; for (const c of chans) for (let i = 0; i < c.length; i++) pk = Math.max(pk, Math.abs(c[i])); if (pk > 0.999) for (const c of chans) for (let i = 0; i < c.length; i++) c[i] *= 0.999 / pk; }
    prog(0.95);
    rep.trimStart = 0; rep.trimEnd = 0;
    if (opts.trim) { const t = trimSilence(chans, sr); chans = t.chans; rep.trimStart = t.start / sr; rep.trimEnd = t.endCut / sr; }
    prog(1);
    return { chans, report: rep };
  }

  // ── Loop finder ──────────────────────────────────────────────────────────
  function ncc(a, ao, b, bo, len) {
    if (len < 8 || ao < 0 || bo < 0 || ao + len > a.length || bo + len > b.length) return -2;
    let ma = 0, mb = 0; for (let i = 0; i < len; i++) { ma += a[ao + i]; mb += b[bo + i]; } ma /= len; mb /= len;
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < len; i++) { const p = a[ao + i] - ma, q = b[bo + i] - mb; ab += p * q; aa += p * p; bb += q * q; }
    return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
  }
  function envelope(x, sr) {
    const h = Math.max(1, Math.round(sr * 0.002)), m = Math.floor(x.length / h), e = new Float32Array(m);
    for (let i = 0; i < m; i++) { let s = 0; for (let j = i * h; j < i * h + h; j++) s += x[j] * x[j]; e[i] = Math.log10(1e-9 + s / h); }
    return { e, h };
  }
  // Nudge the loop end so the audio right after the wrap lines up with what really follows (coarse
  // on the energy envelope, then sample-accurate on the waveform → no click, no flam).
  function refineEnd(x, env, sr, s, e) {
    const E = env.e, h = env.h;
    const D = Math.round(clamp((e - s) * 0.005, 0.01, 0.06) * sr / h), W = Math.round(0.35 * sr / h);
    const si = Math.round(s * sr / h), ei = Math.round(e * sr / h);
    const off = Math.max(-W, -si, -(ei - D)), wl = Math.min(2 * W, E.length - (ei + D) - off, E.length - si - off);
    let bestD = 0;
    if (wl >= 40) { let best = -3; for (let d = -D; d <= D; d++) { const v = ncc(E, si + off, E, ei + d + off, wl); if (v > best) { best = v; bestD = d; } } }
    const sI = Math.round(s * sr), eI = Math.round((e + bestD * h / sr) * sr);
    const w = Math.round(0.006 * sr), R = Math.round(h * 1.5);
    const o2 = -Math.min(w >> 1, sI, eI - R), wl2 = Math.min(2 * w, x.length - (eI + R) - o2, x.length - sI - o2);
    let bd = 0, bc = 0;
    if (wl2 >= 64) { bc = -3; for (let d = -R; d <= R; d++) { const c = ncc(x, sI + o2, x, eI + d + o2, wl2); if (c > bc) { bc = c; bd = d; } } }
    const ne = clamp((eI + bd) / sr, s + 0.05, x.length / sr);
    return { e: ne, corr: bc };
  }
  function loops(payload, prog) {
    const { mono: x, sr, bpm, t0, barBeats, lengths } = payload, maxOut = payload.max || 6;
    const n = x.length, beat = 60 / bpm, NF = sr > 32000 ? 4096 : 2048, hop = NF >> 2, half = NF >> 1, NB = 16;
    if (n < NF * 4) return [];
    const fft = getFFT(NF), win = new Float64Array(NF);
    for (let i = 0; i < NF; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NF);
    const pc = new Int8Array(half + 1).fill(-1), bd = new Int8Array(half + 1).fill(-1);
    for (let k = 1; k <= half; k++) {
      const f = k * sr / NF;
      if (f >= 65 && f <= 4200) pc[k] = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12) % 12;
      if (f >= 40 && f < 15000) bd[k] = Math.min(NB - 1, Math.floor(NB * Math.log(f / 40) / Math.log(15000 / 40)));
    }
    const tf = ((t0 % beat) + beat) % beat, m0 = Math.round((t0 - tf) / beat);
    const B = Math.min(2400, Math.floor((n / sr - tf) / beat));
    if (B < barBeats * 2) return [];
    const chB = new Float64Array(B * 12), bdB = new Float64Array(B * NB), ldB = new Float64Array(B), cnt = new Float64Array(B);
    const re = new Float64Array(NF), im = new Float64Array(NF), F = Math.floor((n - NF) / hop) + 1;
    const take = (fi, which) => {
      const j = Math.floor(((fi * hop + half) / sr - tf) / beat);
      if (j < 0 || j >= B) return;
      let tot = 0;
      for (let k = 1; k <= half; k++) {
        const k2 = NF - k;
        const a = which ? (im[k] + im[k2]) * 0.5 : (re[k] + re[k2]) * 0.5;
        const b = which ? (re[k] - re[k2]) * 0.5 : (im[k] - im[k2]) * 0.5;
        const p = a * a + b * b; tot += p;
        if (pc[k] >= 0) chB[j * 12 + pc[k]] += Math.sqrt(p);
        if (bd[k] >= 0) bdB[j * NB + bd[k]] += p;
      }
      ldB[j] += tot; cnt[j]++;
    };
    for (let f = 0; f < F; f += 2) {           // two real frames per complex FFT
      const g = f + 1 < F, oa = f * hop, ob = g ? (f + 1) * hop : 0;
      for (let i = 0; i < NF; i++) { re[i] = x[oa + i] * win[i]; im[i] = g ? x[ob + i] * win[i] : 0; }
      fft(re, im, false);
      take(f, 0); if (g) take(f + 1, 1);
      if (f % 400 === 0) prog(0.7 * f / F);
    }
    // beat features: chroma (harmony) + spectral shape (timbre), both unit-normalised
    const loud = new Float64Array(B), bm = new Float64Array(NB);
    for (let j = 0; j < B; j++) {
      const c = Math.max(1, cnt[j]); loud[j] = 10 * Math.log10(ldB[j] / c + 1e-20);
      let s = 0; for (let q = 0; q < 12; q++) s += chB[j * 12 + q] ** 2; s = Math.sqrt(s) || 1;
      for (let q = 0; q < 12; q++) chB[j * 12 + q] /= s;
      for (let q = 0; q < NB; q++) { const v = Math.log10(bdB[j * NB + q] / c + 1e-12); bdB[j * NB + q] = v; bm[q] += v / B; }
    }
    for (let j = 0; j < B; j++) {
      let s = 0; for (let q = 0; q < NB; q++) { bdB[j * NB + q] -= bm[q]; s += bdB[j * NB + q] ** 2; } s = Math.sqrt(s) || 1;
      for (let q = 0; q < NB; q++) bdB[j * NB + q] /= s;
    }
    const S = new Float32Array(B * B);
    for (let i = 0; i < B; i++) for (let j = i; j < B; j++) {
      let a = 0, b = 0;
      for (let q = 0; q < 12; q++) a += chB[i * 12 + q] * chB[j * 12 + q];
      for (let q = 0; q < NB; q++) b += bdB[i * NB + q] * bdB[j * NB + q];
      S[i * B + j] = S[j * B + i] = 0.55 * a + 0.45 * b;
    }
    prog(0.8);
    const segSim = (a, b, L) => { let s = 0; for (let i = 0; i < L; i++) s += S[(a + i) * B + b + i]; return s / L; };
    const isDown = j => (((j - m0) % barBeats) + barBeats) % barBeats === 0;
    const downs = []; for (let j = 0; j < B; j++) if (isDown(j)) downs.push(j);
    const ref = pct(Array.from(loud), 0.9), prior = { 1: 0.9, 2: 0.96, 4: 1, 8: 0.97, 16: 0.9 };
    const cands = [];
    for (const bars of lengths) {
      const L = bars * barBeats; if (L > B) continue;
      for (const s of downs) {
        const e = s + L; if (e > B) break;
        let ls = 0, lmin = 1e9; for (let i = s; i < e; i++) { ls += loud[i]; if (loud[i] < lmin) lmin = loud[i]; } ls /= L;
        const eF = clamp((ls - (ref - 18)) / 12, 0, 1); if (eF < 0.1) continue;
        let rep = -2; if (e + L <= B) rep = Math.max(rep, segSim(s, e, L)); if (s - L >= 0) rep = Math.max(rep, segSim(s - L, s, L));
        let seam = 0, sc = 0;
        if (e < B) { seam += S[e * B + s]; sc++; }          // what follows the end ≈ the start?
        if (s > 0) { seam += S[(e - 1) * B + s - 1]; sc++; }  // last beat ≈ what precedes the start?
        seam = sc ? seam / sc : Math.max(rep, 0); if (rep < -1) rep = seam;
        const top = [0, 0, 0];
        for (const p of downs) {
          if (p + L > B) break; if (Math.abs(p - s) < L) continue;
          const v = segSim(s, p, L);
          if (v > top[2]) { top[2] = v; top.sort((a, b) => b - a); }
        }
        const recur = (top[0] + top[1] + top[2]) / 3, quiet = lmin < ref - 35 ? 0.6 : 1;
        cands.push({ s, e, bars, seam, score: (0.4 * rep + 0.35 * seam + 0.25 * recur) * (0.45 + 0.55 * eF) * (prior[bars] || 0.9) * quiet });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    const pick = [];
    for (const c of cands) {
      if (pick.some(o => Math.min(o.e, c.e) - Math.max(o.s, c.s) > 0.5 * Math.min(o.e - o.s, c.e - c.s))) continue;
      pick.push(c); if (pick.length >= maxOut) break;
    }
    const env = envelope(x, sr);
    const out = pick.map(c => {
      const s = tf + c.s * beat, r = refineEnd(x, env, sr, s, Math.min(tf + c.e * beat, n / sr));
      return { s, e: r.e, bars: c.bars, score: c.score, match: Math.round(100 * clamp(0.6 * clamp(c.seam, 0, 1) + 0.4 * Math.max(0, r.corr), 0, 1)) };
    });
    prog(1);
    return out;
  }

  return { clean, loops, limiter, getFFT, lowCut };
})();
if (typeof module !== "undefined") module.exports = DSP;
else if (typeof window !== "undefined") window.DSP = DSP;
