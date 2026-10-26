/* Trip Score — generative film-score engine, played on real instrument recordings
   (VSCO 2 Community Edition, CC0). Works with a live AudioContext or an OfflineAudioContext.
   Each mood is a small "composer" called on every 16th note. */
(function (root) {
  "use strict";

  const R = Math.random;
  const pick = (a) => a[Math.floor(R() * a.length)];
  const rpan = (w = 0.5) => (R() * 2 - 1) * w;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  /* ---------- sample bank ---------- */
  // On phones, keep decoded audio small: stereo recordings are folded to mono after decoding.
  const LOWMEM = typeof navigator !== "undefined" && /iPhone|iPad|iPod|Android/.test(navigator.userAgent || "");
  function toMono(ctx, b) {
    const n = b.length, out = ctx.createBuffer(1, n, b.sampleRate), d = out.getChannelData(0);
    const l = b.getChannelData(0), r = b.getChannelData(1);
    for (let i = 0; i < n; i++) d[i] = (l[i] + r[i]) * 0.5;
    return out;
  }
  // Downloads every instrument once (bytes), decodes only what the current moods need.
  class Bank {
    constructor(loader) {
      this.loader = loader;      // async (file) => ArrayBuffer
      this.map = null; this.raw = {}; this.rawP = {}; this.buf = {}; this.busy = {};
    }
    bytes(n) {   // one download per instrument, however many callers ask
      if (!this.rawP[n]) this.rawP[n] = this.loader(this.map[n].file).then((b) => (this.raw[n] = b), (e) => { delete this.rawP[n]; throw e; });
      return this.rawP[n];
    }
    async init() {
      if (!this.map) this.map = JSON.parse(new TextDecoder().decode(await this.loader("samples.json")));
      return this.map;
    }
    async prefetch(onProgress) {
      await this.init();
      const names = Object.keys(this.map);
      let done = 0;
      await Promise.all(names.map(async (n) => {
        await this.bytes(n);
        onProgress && onProgress(++done / names.length);
      }));
    }
    async ensure(ctx, names) {
      await this.init();
      await Promise.all(names.map((n) => {
        if (this.buf[n]) return null;
        if (!this.busy[n]) this.busy[n] = (async () => {
          const bytes = await this.bytes(n);
          const b = await new Promise((res, rej) => {
            const p = ctx.decodeAudioData(bytes.slice(0), res, rej);
            if (p && p.then) p.then(res, rej);
          });
          this.buf[n] = { buffer: LOWMEM && b.numberOfChannels > 1 ? toMono(ctx, b) : b, notes: this.map[n].notes };
          delete this.busy[n];
        })();
        return this.busy[n];
      }));
    }
    get(n) { return this.buf[n]; }
    // Free decoded audio no longer needed (keeps the downloaded bytes).
    keepOnly(names) {
      const keep = new Set(names);
      for (const n of Object.keys(this.buf)) if (!keep.has(n)) delete this.buf[n];
    }
  }

  // Synthetic hall: pre-delay, sparse early reflections, then a decorrelated stereo tail whose
  // high frequencies die away faster than the lows (as in a real room).
  function makeIR(ctx, seconds, decay) {
    const sr = ctx.sampleRate, len = Math.floor(sr * seconds);
    const b = ctx.createBuffer(2, len, sr);
    const pre = Math.floor(sr * 0.022);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      // early reflections (different per ear)
      for (let k = 0; k < 10; k++) {
        const at = pre + Math.floor(sr * (0.006 + 0.075 * Math.pow(R(), 1.3)));
        if (at < len) d[at] += (R() < 0.5 ? -1 : 1) * (0.5 - 0.035 * k) * (0.6 + 0.4 * R());
      }
      let lp = 0, lp2 = 0;
      for (let i = pre; i < len; i++) {
        const t = (i - pre) / (len - pre);
        const k = 0.75 * Math.pow(1 - t, 1.6) + 0.04;          // brightness falls over time
        lp += k * ((R() * 2 - 1) - lp);
        lp2 += 0.5 * (lp - lp2);
        const env = Math.pow(1 - t, decay) * (1 - Math.exp(-(i - pre) / (sr * 0.03)));   // soft onset of the tail
        d[i] += lp2 * env * 0.9;
      }
    }
    return b;
  }

  /* ---------- voices ---------- */
  function voiceOut(L, pan, dest) {
    const ctx = L.ctx;
    const g = ctx.createGain();
    g.gain.value = 0;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan || 0, -1, 1);
      g.connect(p); p.connect(dest || L.bus);
    } else g.connect(dest || L.bus);
    return g;
  }
  function nearest(notes, midi) {
    let best = notes[0], bd = 1e9;
    for (const n of notes) {
      const d = Math.abs(n.m - midi) + (n.m > midi ? 0.01 : 0); // prefer shifting up (brighter) on ties
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  // Play one recorded note. midi=null plays an unpitched one-shot (o.i = which hit).
  function play(L, inst, midi, t, o = {}) {
    const b = L.e.bank.get(inst);
    if (!b) return 0;
    const ctx = L.ctx;
    t = Math.max(0, t);   // humanised timing may nudge the first note before zero
    const n = midi == null ? b.notes[o.i == null ? Math.floor(R() * b.notes.length) : o.i] : nearest(b.notes, midi);
    const rate = midi == null ? (o.rate || 1) : Math.pow(2, (midi - n.m) / 12);
    const skip = o.skip || 0;
    const avail = (n.d - skip) / rate;
    const src = ctx.createBufferSource();
    src.buffer = b.buffer;
    src.playbackRate.value = rate;
    src.detune.value = (R() - 0.5) * (o.human == null ? 6 : o.human);
    const g = voiceOut(L, o.pan == null ? rpan(0.35) : o.pan, o.dest);
    let node = src;
    if (o.cutoff) {
      const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = o.cutoff; f.Q.value = 0.5;
      src.connect(f); node = f;
    }
    node.connect(g);
    const peak = o.gain == null ? 0.3 : o.gain, a = o.a || 0.004;
    const len = Math.min(o.dur == null ? avail : o.dur, avail);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    let end = t + avail;
    if (len < avail - 0.02) {
      const r = Math.min(o.r == null ? 0.25 : o.r, avail - len);
      g.gain.setValueAtTime(peak, t + Math.max(a, len));
      g.gain.linearRampToValueAtTime(0, t + Math.max(a, len) + r);
      end = t + Math.max(a, len) + r;
    }
    src.start(t, n.o + skip, n.d - skip);
    src.stop(end + 0.05);
    return avail;
  }

  // A note held for `dur` seconds, longer than the recording if needed:
  // overlapping re-entries cross-fade inside the sustained part of the sample.
  function hold(L, inst, midi, t, dur, o = {}) {
    const b = L.e.bank.get(inst);
    if (!b) return;
    const n = nearest(b.notes, midi);
    const rate = Math.pow(2, (midi - n.m) / 12);
    const usable = (n.d / rate) * 0.66;                 // the last third is the recording's fade
    const pan = o.pan == null ? rpan(0.45) : o.pan;
    const r = o.r == null ? 1.5 : o.r;
    if (dur + r <= usable + (n.d / rate) * 0.3) { play(L, inst, midi, t, Object.assign({}, o, { dur, r, pan })); return; }
    const xf = Math.min(1.6, usable * 0.4);
    let ts = t, k = 0;
    while (ts < t + dur - 0.05) {
      const segEnd = Math.min(ts + usable, t + dur);
      const last = segEnd >= t + dur - 0.05;
      play(L, inst, midi, ts, Object.assign({}, o, {
        a: k ? xf : (o.a || 1), dur: segEnd - ts, r: last ? r : xf, skip: k ? 0.3 : 0, pan, human: 0,
      }));
      ts += usable - xf; k++;
    }
  }
  const chordHold = (L, inst, notes, t, dur, o = {}) =>
    notes.forEach((m, i) => hold(L, inst, m, t + i * (o.roll || 0), dur, Object.assign({}, o, { pan: o.spread ? ((i / Math.max(1, notes.length - 1)) * 2 - 1) * o.spread : undefined })));
  const strum = (L, inst, notes, t, o = {}) =>
    notes.forEach((m, i) => play(L, inst, m, t + i * (o.spread || 0.03), Object.assign({}, o, { pan: (i / notes.length - 0.5) * 0.7 })));

  /* ---------- composer: form, tension arc, voice leading, themes, swells ---------- */

  // Instruments recorded at two dynamics: [soft, loud]. A swell crossfades between them,
  // so the tone itself brightens as the music grows, as a real section would.
  const DYN = {
    violins: ["violins_p", "violins"], violas: ["violas", "violas_f"], cellos: ["cellos", "cellos_f"],
    basses: ["basses", "basses_f"], horn: ["horn", "horn_f"], harmon: ["harmon", "harmon_f"],
    vlns: ["vlns_p", "vlns_f"], vlas: ["vlas_p", "vlas_f"], vcs: ["vcs_p", "vcs_f"],
    mutetpt: ["mutetpt_p", "mutetpt_f"], clar2: ["clar2_p", "clar2_f"],
  };
  const layersOf = (names) => [...new Set(names.flatMap((n) => DYN[n] || [n]))];
  const pc12 = (n) => ((n % 12) + 12) % 12;

  // Chord tones that never rub: drop any tone a semitone away from a more essential one
  // (chords are listed root, third, fifth, seventh, extensions).
  function safeTones(chord) {
    const out = [];
    for (const n of chord) {
      const p = pc12(n);
      if (out.some((q) => { const d = Math.abs(pc12(q) - p); return d === 1 || d === 11 || d === 0; })) continue;
      out.push(n);
    }
    return out;
  }

  // Expression envelope: dynamic d runs d0 -> d1 with a breath (swell) in the middle.
  // Returns [softNode, loudNode] gain nodes with complementary, equal-power curves.
  function expression(L, t, dur, o) {
    const ctx = L.ctx, a = o.a || 0.6, r = o.r || 1.2, peak = o.gain || 0.2;
    const d0 = clamp(o.d0 == null ? 0.4 : o.d0, 0, 1), d1 = clamp(o.d1 == null ? d0 : o.d1, 0, 1), sw = o.swell || 0;
    return [0, 1].map((layer) => {
      const g = ctx.createGain();
      g.connect(L.bus);
      const lvl = (x) => {
        const d = clamp(d0 + (d1 - d0) * x + sw * Math.sin(Math.PI * x), 0, 1);
        const amt = peak * (0.15 + 0.85 * d);
        return amt * (layer ? Math.sin(d * Math.PI / 2) : Math.cos(d * Math.PI / 2));
      };
      const aa = Math.min(a, dur * 0.5);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(lvl(0), t + aa);
      const pts = Math.max(2, Math.ceil(dur / 0.6));
      for (let i = 1; i <= pts; i++) g.gain.linearRampToValueAtTime(lvl(i / pts), t + Math.max(aa, dur * (i / pts)));
      g.gain.linearRampToValueAtTime(0, t + dur + r);
      return g;
    });
  }

  // A bowed / blown note with real dynamics: both recorded layers, shaped by `expression`.
  function bowed(L, inst, midi, t, dur, o = {}) {
    const pair = DYN[inst];
    const pan = o.pan == null ? rpan(0.4) : o.pan;
    const t0 = Math.max(0, t + (o.late || 0));
    if (!pair || !L.e.bank.get(pair[0]) || !L.e.bank.get(pair[1])) {
      const d = o.d1 == null ? 0.5 : o.d1;
      hold(L, inst, midi, t0, dur, Object.assign({}, o, { gain: (o.gain || 0.2) * (0.3 + 0.7 * d), pan }));
      return;
    }
    const nodes = expression(L, t0, dur, o);
    const r = o.r || 1.2;
    pair.forEach((name, i) => hold(L, name, midi, t0, dur + r, { gain: 1, a: 0.02, r: 0.05, pan, dest: nodes[i], cutoff: o.cutoff }));
  }

  // Voice leading: move each voice to the nearest tone of the next chord, keep common tones,
  // avoid crossings, big leaps, and rubbing intervals (minor 2nds / 9ths, close major 7ths).
  function voiceLead(prev, chord, ranges) {
    const safe = safeTones(chord).map(pc12), tones = safe;   // voice only tones that never rub against each other or the melody
    const n = ranges.length;
    const cands = ranges.map(([lo, hi]) => {
      const out = [];
      for (let m = lo; m <= hi; m++) if (tones.includes(m % 12)) out.push(m);
      return out;
    });
    let best = null, bestCost = Infinity;
    const cur = new Array(n);
    const score = (usePrev) => {
      const used = new Set(cur.map((m) => m % 12));
      let cost = 0;
      for (let i = 0; i < n; i++) cost += usePrev ? Math.abs(cur[i] - usePrev[i]) : Math.abs(cur[i] - (ranges[i][0] + ranges[i][1]) / 2) * 0.3;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const d = cur[j] - cur[i];
        if (d % 12 === 1 || d === 11 || (d % 12 === 11 && d < 20)) cost += 8;   // rubbing intervals
        if (d < 3 && i < n - 1 && cur[i] < 52) cost += 4;                        // muddy low clusters
      }
      for (const s of safe) if (!used.has(s)) cost += 3;                           // complete the triad first
      if (!used.has(tones[0])) cost += 3;
      return cost;
    };
    const rec = (v, usePrev) => {
      if (v === n) {
        const c = score(usePrev);
        if (c < bestCost) { bestCost = c; best = cur.slice(); }
        return;
      }
      for (const m of cands[v]) {
        if (v && m <= cur[v - 1]) continue;
        if (usePrev && Math.abs(m - usePrev[v]) > 7) continue;
        cur[v] = m; rec(v + 1, usePrev);
      }
    };
    rec(0, prev);
    if (!best) rec(0, null);
    return best || ranges.map(([lo, hi]) => (lo + hi) >> 1);
  }

  // Keep the melody consonant with the harmony under it. Short notes on weak beats may pass;
  // anything long, accented, or rubbing a semitone against a chord tone moves to the nearest safe tone.
  function fitNote(m, chordAbs, len, strong, nextChordAbs, crossing) {
    const safe = safeTones(chordAbs).map(pc12);
    const nearest = (x, set) => {
      let best = x, bd = 99;
      for (let k = -3; k <= 3; k++) if (set.includes(pc12(x + k)) && (Math.abs(k) < bd || (Math.abs(k) === bd && k < 0))) { bd = Math.abs(k); best = x + k; }
      return best;
    };
    const p = pc12(m);
    if (!safe.includes(p)) {
      const rubs = safe.some((q) => { const d = Math.abs(q - p); return d === 1 || d === 11; });
      if (strong || len >= 4 || (rubs && len >= 2)) m = nearest(m, safe);
    }
    // a note held across the bar line must also sit in the next chord
    if (crossing && nextChordAbs && !safeTones(nextChordAbs).map(pc12).includes(pc12(m))) return { midi: m, cut: true };
    return { midi: m, cut: false };
  }

  // Diatonic transpose of a key-relative note by `steps` scale degrees.
  function diatonic(n, steps, scale) {
    const oct = Math.floor(n / 12), pc = pc12(n);
    let idx = scale.indexOf(pc);
    if (idx < 0) return n + steps * 2;
    idx += steps;
    return scale[((idx % scale.length) + scale.length) % scale.length] + 12 * (oct + Math.floor(idx / scale.length));
  }
  const seq = (motif, steps, scale) => motif.map(([n, len]) => [n == null ? null : diatonic(n, steps, scale), len]);
  const aug = (motif, k) => motif.map(([n, len]) => [n, Math.round(len * k)]);
  const head = (motif, k) => motif.slice(0, k);

  // Build one pass through the mood's form: bars with harmony, voice-led parts (common tones tied),
  // and the melody of every section, fitted to the harmony.
  function planCycle(L, m) {
    const bars = [], form = m.form, BS = m.barSteps || 16;
    form.forEach((sec, si) => {
      for (let b = 0; b < sec.bars; b++) {
        const chordName = sec.prog[b % sec.prog.length];
        const chord = m.chords[chordName];
        bars.push({ sec, si, b, chordName, chord, safe: safeTones(chord) });
      }
    });
    bars.forEach((bar) => {
      const prevI = bar.si ? form[bar.si - 1].i : form[form.length - 1].i;
      const k = clamp((bar.b + 1) / Math.min(3, bar.sec.bars), 0, 1);
      bar.tension = prevI + (bar.sec.i - prevI) * (0.5 - 0.5 * Math.cos(Math.PI * k));
    });
    const upper = m.voices.map((v, i) => i).filter((i) => !m.voices[i].bass).sort((x, y) => m.voices[x].range[0] - m.voices[y].range[0]);
    let prev = L.voicing || null;
    const prevBass = L.bassNote || {};
    bars.forEach((bar) => {
      const vl = upper.length ? voiceLead(prev, bar.chord.map((x) => x + m.root), upper.map((i) => m.voices[i].range)) : [];
      if (upper.length) prev = vl;
      bar.voicing = m.voices.map((v, i) => {
        if (!v.bass) return vl[upper.indexOf(i)];
        const pc = pc12((bar.sec.pedal ? m.chords[bar.sec.pedal][0] : bar.chord[0]) + m.root);
        const ref = prevBass[i] || (v.range[0] + v.range[1]) / 2;
        let best = null;
        for (let x = v.range[0]; x <= v.range[1]; x++) if (x % 12 === pc && (best == null || Math.abs(x - ref) < Math.abs(best - ref))) best = x;
        prevBass[i] = best;
        return best;
      });
    });
    L.voicing = prev; L.bassNote = prevBass;
    const ties = m.voices.map((v, vi) => {
      const out = [];
      bars.forEach((bar, i) => {
        const note = bar.voicing[vi], last = out[out.length - 1];
        const active = !v.silent && (v.when ? v.when(bar.sec, bar) : true);
        if (last && last.note === note && last.active === active && last.end === i) last.end = i + 1;
        else out.push({ start: i, end: i + 1, note, active });
      });
      return out.filter((x) => x.active);
    });
    const mel = [];
    let barIdx = 0;
    form.forEach((sec) => {
      if (sec.mel) sec.mel(L, m, (motif, atBar, opt = {}) => {
        let pos = 0;
        motif.forEach(([n, len]) => {
          if (n != null) mel.push(Object.assign({ bar: barIdx + atBar + Math.floor(pos / BS), step: pos % BS, n, len }, opt));
          pos += len;
        });
      });
      barIdx += sec.bars;
    });
    const strongEvery = BS === 12 ? 12 : 8;
    mel.forEach((e) => {
      e.bar %= bars.length;
      const bar = bars[e.bar], next = bars[(e.bar + 1) % bars.length];
      const root = m.melRoot + (e.oct || 0);
      const crossing = e.step + e.len > BS;
      const f = fitNote(root + e.n, bar.chord.map((x) => x + m.melRoot), e.len, e.step % strongEvery === 0, next.chord.map((x) => x + m.melRoot), crossing);
      e.midi = f.midi;
      if (f.cut) e.len = BS - e.step;
    });
    L.plan = { bars, ties, mel, len: bars.length, BS };
    L.cycle = (L.cycle || 0) + 1;
  }

  // Effective dynamic for a tension value: presence widens how far the arc may swing.
  const dynOf = (L, tension) => clamp(0.12 + tension * (0.45 + 0.5 * L.e.intensity), 0, 1);

  // Shared step for composed moods: sustained parts from the plan, melody, then the mood's own colour.
  function composedStep(m, L, t, s) {
    const sd = L.sd, BS = m.barSteps || 16, barLen = BS * sd;
    if (!L.plan || s % (L.plan.len * BS) === 0) planCycle(L, m);
    const bi = Math.floor(s / BS) % L.plan.len, st = s % BS;
    const bar = L.plan.bars[bi];
    L.bar = bar; L.ch = bar.chord; L.safe = bar.safe; L.tension = bar.tension;
    if (st === 0) {
      m.voices.forEach((v, vi) => {
        L.plan.ties[vi].forEach((tie) => {
          if (tie.start !== bi) return;
          const nb = tie.end - tie.start, endBar = L.plan.bars[Math.min(tie.end, L.plan.len) - 1];
          bowed(L, v.inst, tie.note, t, nb * barLen + 0.2, {
            gain: v.gain, d0: dynOf(L, bar.tension) * (v.dyn || 1), d1: dynOf(L, endBar.tension) * (v.dyn || 1),
            swell: nb >= 2 ? 0.1 : 0.05, a: v.a || 1.2, r: v.r || 1.4, pan: v.pan, late: R() * 0.025,
          });
        });
      });
    }
    for (const e of L.plan.mel) {
      if (e.bar !== bi || e.step !== st) continue;
      const len = e.len * sd;
      const d = dynOf(L, bar.tension) * (e.dyn || 1);
      const late = (m.swing && e.step % 4 === 2 ? sd * m.swing : 0) + (R() - 0.5) * 0.016;
      if (DYN[e.inst]) bowed(L, e.inst, e.midi, t, len * (e.legato || 0.97), { gain: e.gain, d0: d * 0.85, d1: d, swell: len > 1 ? 0.12 : 0.04, a: e.a || Math.min(0.2, len * 0.3), r: e.r || 0.35, pan: e.pan, late });
      else if (e.inst === "piano") felt(L, e.midi, t + late, { gain: e.gain * (0.5 + 0.5 * d), dur: len * (e.legato || 0.97) + 0.6, r: 0.8, pan: e.pan, cutoff: e.cutoff || 1900 });
      else play(L, e.inst, e.midi, t + late, { gain: e.gain * (0.5 + 0.5 * d), dur: len * (e.legato || 0.97), a: e.a || 0.03, r: e.r || 0.35, pan: e.pan, cutoff: e.cutoff });
    }
    if (m.colour) m.colour(L, t, s, bar, bi);
  }
  // Is the melody playing this bar on a given instrument? (colour parts step aside for it)
  const melodyIn = (L, bi, inst) => L.plan.mel.some((e) => e.bar === bi && (!inst || e.inst === inst));

  /* ---------- the moods (modern-minimal pass) ---------- */
  // Underscore, not songs: slow modal harmony (two to four bars a chord), open voicings, pedal points,
  // ostinatos on felt piano or strings, and short motifs of a few long notes that appear now and then.

  const two = (...names) => names.flatMap((n) => [n, n]);
  const four = (...names) => names.flatMap((n) => [n, n, n, n]);
  // Chord tones (safe ones only) laid out in one octave from `lo`, low to high.
  const near = (m, bar, lo) => bar.safe.map((x) => { let n = m.root + x; while (n < lo) n += 12; while (n >= lo + 12) n -= 12; return n; }).sort((a, b) => a - b);
  // Felt piano: a muted, darker upright.
  const felt = (L, midi, t, o = {}) => play(L, "piano2_pp", midi, t, Object.assign({ cutoff: 1800, a: 0.012, human: 3 }, o, { gain: (o.gain || 0.1) * 1.6 }));
  // Broken-chord figure repeated over slowly moving harmony (Richter / Jóhannsson style).
  function ostinato(L, m, t, s, bar, o) {
    const every = o.every || 2;
    if (s % every) return;
    const k = Math.floor(s / every) % o.pattern.length, idx = o.pattern[k];
    if (idx == null) return;
    const tones = near(m, bar, o.lo);
    const n = tones[idx % tones.length] + 12 * Math.floor(idx / tones.length);
    const g = o.gain * (0.45 + 0.75 * L.tension) * (k === 0 ? 1.15 : 1);
    if ((o.inst || "piano") === "piano") felt(L, n, t + (R() - 0.5) * 0.012, { gain: g, cutoff: o.cutoff || 1800, pan: o.pan == null ? (k % 2 ? 0.12 : -0.12) : o.pan });
    else play(L, o.inst, n, t, { gain: g, pan: o.pan == null ? rpan(0.2) : o.pan, dur: o.dur, r: o.r });
  }
  // A single soft piano note now and then, high and far away.
  function sparks(L, m, t, s, bar, p, lo) {
    if (s % 4 || R() > p) return;
    const tones = near(m, bar, lo);
    felt(L, pick(tones), t, { gain: 0.08 + 0.05 * L.tension, cutoff: 2400, pan: rpan(0.5) });
  }

  const MOODS = {
    dreamy: {
      name: "Dreamy", line: "Half-awake, floating, slow light through a window.",
      colors: ["#7f9cff", "#c3a2ff", "#3b3f8f"],
      uses: layersOf(["vlns", "vlas", "vcs", "dbarco", "piano2_pp"]),
      bpm: 52, wet: 0.85, dry: 0.6, root: 50, melRoot: 62, level: 2.2,
      scale: [0, 2, 4, 6, 7, 9, 11],
      chords: { I: [0, 7, 4, 14], II: [2, 9, 6], vi: [11, 18, 14], iii: [6, 13, 9] },
      voices: [
        { inst: "vlns", range: [69, 84], gain: 0.09, pan: 0.45, dyn: 0.8, when: (sec) => sec.i >= 0.35 },
        { inst: "vlns", range: [62, 76], gain: 0.1, pan: 0.25, dyn: 0.85 },
        { inst: "vlas", range: [55, 69], gain: 0.11, pan: -0.2 },
        { inst: "vcs", range: [45, 57], gain: 0.1, pan: -0.4 },
        { inst: "dbarco", bass: true, range: [33, 45], gain: 0.1, pan: 0.1, when: (sec) => sec.i >= 0.3 },
      ],
      theme: { A: [[7, 16], [4, 8], [2, 24]], B: [[9, 16], [7, 16]] },
      get form() {
        const T = this.theme, va = { inst: "vlas", gain: 0.11, pan: 0.1 };
        return [
          { name: "establish", bars: 4, i: 0.15, prog: four("I"), pedal: "I" },
          { name: "A", bars: 8, i: 0.32, prog: two("I", "II", "I", "vi"), mel: (L, m, put) => put(T.A, 2, va) },
          { name: "B", bars: 8, i: 0.45, prog: two("vi", "iii", "II", "II"), mel: (L, m, put) => put(T.B, 3, va) },
          { name: "peak", bars: 8, i: 0.62, prog: two("I", "II", "vi", "II"), mel: (L, m, put) => put(T.A, 2, { inst: "vlns", gain: 0.1, oct: 12, pan: 0.3 }) },
          { name: "release", bars: 8, i: 0.28, prog: two("I", "II", "I", "I") },
          { name: "breath", bars: 4, i: 0.12, prog: four("I"), pedal: "I" },
        ];
      },
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar) { sparks(L, this, t, s, bar, 0.05 + 0.1 * L.tension, 74); },
    },

    lovely: {
      name: "Lovely", line: "Warm, tender, someone you are glad is next to you.",
      colors: ["#ff9fb2", "#ffcb9a", "#8a3d5c"],
      uses: layersOf(["piano2_pp", "vlns", "vlas", "vcs", "dbarco"]),
      bpm: 58, wet: 0.55, dry: 0.8, root: 53, melRoot: 65, level: 2.45,
      scale: [0, 2, 4, 5, 7, 9, 11],
      chords: { I: [0, 7, 4, 14], iii: [4, 11, 7], IV: [5, 12, 9, 19], vi: [9, 16, 12], Vsus: [7, 14, 12] },
      voices: [
        { inst: "vlns", range: [65, 79], gain: 0.08, pan: 0.35, dyn: 0.85, when: (sec) => sec.i >= 0.45 },
        { inst: "vlas", range: [55, 67], gain: 0.08, pan: -0.15, when: (sec) => sec.i >= 0.3 },
        { inst: "vcs", range: [45, 57], gain: 0.09, pan: -0.3, when: (sec) => sec.i >= 0.25 },
        { inst: "dbarco", bass: true, range: [29, 41], gain: 0.08, pan: 0.1, when: (sec) => sec.i >= 0.4 },
      ],
      theme: { A: [[4, 12], [2, 4], [0, 16]], B: [[7, 8], [9, 8], [7, 16]] },
      get form() {
        const T = this.theme, vc = { inst: "vcs", gain: 0.11, oct: -12, pan: -0.15 };
        return [
          { name: "intro", bars: 4, i: 0.15, prog: two("I", "IV"), pedal: "I" },
          { name: "A", bars: 8, i: 0.32, prog: two("I", "iii", "IV", "I"), mel: (L, m, put) => put(T.A, 4, vc) },
          { name: "B", bars: 8, i: 0.45, prog: two("vi", "IV", "I", "Vsus"), mel: (L, m, put) => put(T.B, 2, vc) },
          { name: "peak", bars: 8, i: 0.6, prog: two("IV", "I", "vi", "Vsus"), mel: (L, m, put) => { put(T.A, 0, { inst: "vlns", gain: 0.1, pan: 0.3 }); put(T.B, 4, vc); } },
          { name: "release", bars: 8, i: 0.28, prog: two("IV", "I", "Vsus", "I") },
          { name: "breath", bars: 4, i: 0.12, prog: two("I", "I"), pedal: "I" },
        ];
      },
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar) {
        const m = this, st = s % 16;
        ostinato(L, m, t, s, bar, { pattern: [0, 2, 1, 3, 2, 1, 3, 2], lo: 60, gain: 0.11 });
        if (st === 0 && bar.b % 2 === 0) felt(L, m.root - 12 + bar.chord[0], t, { gain: 0.14, pan: -0.2 });
      },
    },

    happy: {
      name: "Happy", line: "Windows down, sun on the dashboard, no hurry.",
      colors: ["#ffd36b", "#7fe0c2", "#e2793f"],
      uses: layersOf(["piano2_pp", "vlns", "vlas", "vcs", "dbarco", "cellospic", "horn"]),
      bpm: 84, wet: 0.45, dry: 0.8, root: 55, melRoot: 67, level: 2.37,
      scale: [0, 2, 4, 5, 7, 9, 11],
      chords: { I: [0, 7, 4, 14], IV: [5, 12, 9, 19], vi: [9, 16, 12], Vsus: [7, 14, 12], iii: [4, 11, 7] },
      voices: [
        { inst: "vlns", range: [67, 83], gain: 0.08, pan: 0.4, when: (sec) => sec.i >= 0.45 },
        { inst: "vlas", range: [57, 69], gain: 0.08, pan: -0.1, when: (sec) => sec.i >= 0.3 },
        { inst: "vcs", range: [47, 59], gain: 0.09, pan: -0.3 },
        { inst: "dbarco", bass: true, range: [31, 43], gain: 0.09, pan: 0.1, when: (sec) => sec.i >= 0.35 },
      ],
      theme: { A: [[4, 8], [7, 8], [9, 24], [7, 8]], B: [[12, 16], [11, 8], [7, 24]] },
      get form() {
        const T = this.theme, hn = { inst: "horn", gain: 0.12, oct: -12, pan: -0.25 };
        return [
          { name: "intro", bars: 4, i: 0.22, prog: two("I", "I") },
          { name: "A", bars: 8, i: 0.4, prog: two("I", "IV", "vi", "IV"), mel: (L, m, put) => put(T.A, 2, hn) },
          { name: "B", bars: 8, i: 0.5, prog: two("I", "Vsus", "IV", "IV"), mel: (L, m, put) => put(T.B, 4, { inst: "vlns", gain: 0.09, pan: 0.3 }) },
          { name: "peak", bars: 8, i: 0.7, prog: two("I", "iii", "IV", "Vsus"), mel: (L, m, put) => { put(T.A, 0, hn); put(T.B, 4, { inst: "vlns", gain: 0.1, pan: 0.3 }); } },
          { name: "release", bars: 8, i: 0.32, prog: two("IV", "I", "IV", "I") },
        ];
      },
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar) {
        const m = this, ten = L.tension;
        ostinato(L, m, t, s, bar, { pattern: [0, 1, 2, 3, 2, 1, 2, 3], lo: 62, gain: 0.1, cutoff: 2600 });
        if (ten > 0.42 && s % 2 === 0) {
          const pat = [0, 0, 7, 0, 12, 0, 7, 0];
          play(L, "cellospic", m.root - 12 + bar.chord[0] + pat[(s / 2) % 8], t, { gain: 0.04 + 0.08 * ten, pan: -0.3 });
        }
      },
    },

    wonder: {
      name: "Wonder", line: "Mountains turning gold. The whole world, wider than you remembered.",
      colors: ["#8fe3d4", "#ffe2a3", "#2f6f8f"],
      uses: layersOf(["vlns", "vlas", "vcs", "dbarco", "horn", "piano2_pp", "vlntrem", "timpani"]),
      bpm: 62, wet: 0.75, dry: 0.7, root: 52, melRoot: 64, level: 2.22,
      scale: [0, 2, 4, 5, 7, 9, 11],
      chords: { I: [0, 7, 4, 14], bVII: [10, 17, 14, 24], IV: [5, 12, 9, 19], bVI: [8, 15, 12] },
      voices: [
        { inst: "vlns", range: [71, 86], gain: 0.09, pan: 0.5, when: (sec) => sec.i >= 0.45 },
        { inst: "vlns", range: [64, 78], gain: 0.1, pan: 0.3 },
        { inst: "vlas", range: [55, 69], gain: 0.11, pan: -0.1 },
        { inst: "vcs", range: [43, 57], gain: 0.11, pan: -0.35 },
        { inst: "dbarco", bass: true, range: [28, 40], gain: 0.12, pan: 0.1, when: (sec) => sec.i >= 0.3 },
        { inst: "vlntrem", range: [76, 88], gain: 0.025, pan: -0.5, when: (sec) => sec.i >= 0.6 },
      ],
      theme: { A: [[0, 8], [7, 12], [4, 28]], B: [[2, 8], [7, 8], [9, 32]] },
      get form() {
        const T = this.theme, hn = { inst: "horn", gain: 0.13, oct: -12, pan: -0.25 };
        return [
          { name: "establish", bars: 4, i: 0.18, prog: four("I"), pedal: "I" },
          { name: "A", bars: 8, i: 0.38, prog: two("I", "bVII", "IV", "I"), mel: (L, m, put) => put(T.A, 2, hn) },
          { name: "B", bars: 8, i: 0.5, prog: two("bVI", "bVII", "I", "I"), mel: (L, m, put) => put(T.B, 2, hn) },
          { name: "peak", bars: 8, i: 0.78, prog: two("I", "bVII", "IV", "I"), mel: (L, m, put) => { put(T.A, 0, { inst: "vlns", gain: 0.11, pan: 0.35 }); put(T.A, 0, hn); put(T.B, 4, hn); } },
          { name: "release", bars: 8, i: 0.32, prog: two("IV", "I", "bVII", "I") },
          { name: "breath", bars: 4, i: 0.12, prog: four("I"), pedal: "I" },
        ];
      },
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar) {
        const m = this;
        sparks(L, m, t, s, bar, 0.04 + 0.08 * L.tension, 76);
        if (bar.sec.name === "peak" && bar.b === 0 && s % 16 === 0) play(L, "timpani", m.root - 24 + bar.chord[0], t, { gain: 0.16, pan: 0 });
      },
    },

    fairytale: {
      name: "Fairy tale", line: "Once upon a time, a little lantern in a big dark forest.",
      colors: ["#f5b8ff", "#a9d8ff", "#4b3a8f"],
      uses: layersOf(["harp2", "clar2", "vlns", "vlas", "vcs", "dbarco"]),
      bpm: 108, barSteps: 12, wet: 0.65, dry: 0.75, root: 50, melRoot: 62, level: 2.35,
      scale: [0, 2, 3, 5, 7, 9, 10],
      chords: { i: [0, 7, 3], IV: [5, 12, 9], III: [3, 10, 7], VII: [10, 17, 14] },
      voices: [
        { inst: "vlns", range: [65, 79], gain: 0.07, pan: 0.4, dyn: 0.85, when: (sec) => sec.i >= 0.45 },
        { inst: "vlas", range: [55, 67], gain: 0.08, pan: -0.15 },
        { inst: "vcs", range: [45, 57], gain: 0.08, pan: -0.3, when: (sec) => sec.i >= 0.3 },
        { inst: "dbarco", bass: true, range: [31, 43], gain: 0.09, pan: 0.1 },
      ],
      theme: { A: [[7, 12], [5, 6], [3, 6], [2, 12], [0, 12]], B: [[3, 12], [5, 12], [7, 24]] },
      get form() {
        const T = this.theme, cl = { inst: "clar2", gain: 0.1, oct: -12, pan: 0.25 };
        return [
          { name: "intro", bars: 8, i: 0.18, prog: two("i", "i", "IV", "i") },
          { name: "A", bars: 16, i: 0.35, prog: two("i", "IV", "i", "VII", "III", "VII", "IV", "i"), mel: (L, m, put) => { put(T.A, 2, cl); put(T.B, 10, cl); } },
          { name: "peak", bars: 16, i: 0.55, prog: two("III", "VII", "IV", "i", "III", "VII", "IV", "IV"), mel: (L, m, put) => put(T.A, 4, { inst: "vlns", gain: 0.09, pan: 0.3 }) },
          { name: "release", bars: 16, i: 0.28, prog: two("i", "IV", "i", "VII", "IV", "i", "i", "i"), mel: (L, m, put) => put(T.B, 6, cl) },
        ];
      },
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar) {
        // a slow waltz on the harp: low note on one, two quiet chord tones on two and three
        const m = this, st = s % 12, ten = L.tension;
        if (st === 0) play(L, "harp2", m.root - 12 + bar.chord[0], t, { gain: 0.14 + 0.06 * ten, pan: -0.15 });
        if (st === 4 || st === 8) { const tn = near(m, bar, 57); play(L, "harp2", tn[st === 4 ? 0 : 1], t, { gain: 0.07 + 0.04 * ten, pan: 0.15 }); play(L, "harp2", tn[2 % tn.length], t + 0.015, { gain: 0.06 + 0.03 * ten, pan: 0.2 }); }
      },
    },

    melancholy: {
      name: "Melancholy", line: "Rain on the window. The last day of the trip.",
      colors: ["#8aa0b8", "#5d6f8a", "#1d2738"],
      uses: layersOf(["piano2_pp", "vcs", "vlas", "vlns", "dbarco", "clar2"]),
      bpm: 54, wet: 0.75, dry: 0.75, root: 45, melRoot: 57, level: 2.66,
      scale: [0, 2, 3, 5, 7, 8, 10],
      chords: { i: [0, 7, 3], VI: [8, 15, 12], III: [3, 10, 7], VII: [10, 17, 14], iv: [5, 12, 8] },
      voices: [
        { inst: "vlns", range: [64, 76], gain: 0.07, pan: 0.35, dyn: 0.8, when: (sec) => sec.i >= 0.45 },
        { inst: "vlas", range: [55, 67], gain: 0.08, pan: 0.15, when: (sec) => sec.i >= 0.25 },
        { inst: "vcs", range: [45, 57], gain: 0.09, pan: -0.15, when: (sec) => sec.i >= 0.3 },
        { inst: "dbarco", bass: true, range: [28, 40], gain: 0.09, pan: -0.1 },
      ],
      theme: { A: [[7, 12], [3, 4], [2, 16], [0, 16]], B: [[8, 16], [7, 16], [3, 32]] },
      get form() {
        const T = this.theme, vc = { inst: "vcs", gain: 0.11, pan: -0.2 };
        return [
          { name: "intro", bars: 4, i: 0.12, prog: two("i", "VI") },
          { name: "A", bars: 8, i: 0.28, prog: two("i", "VI", "III", "VII"), mel: (L, m, put) => put(T.A, 2, vc) },
          { name: "B", bars: 8, i: 0.42, prog: two("VI", "VII", "i", "i"), mel: (L, m, put) => put(T.B, 2, { inst: "clar2", gain: 0.09, pan: 0.3 }) },
          { name: "peak", bars: 8, i: 0.55, prog: two("iv", "VI", "III", "VII"), mel: (L, m, put) => put(T.A, 0, { inst: "vlns", gain: 0.09, oct: 12, pan: 0.3 }) },
          { name: "release", bars: 8, i: 0.22, prog: two("i", "VI", "iv", "i") },
        ];
      },
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar) {
        const m = this;
        ostinato(L, m, t, s, bar, { every: 4, pattern: [0, 1, 2, 1], lo: 57, gain: 0.12, cutoff: 1500 });
        if (s % 16 === 0 && bar.b % 2 === 0) felt(L, m.root - 12 + bar.chord[0], t, { gain: 0.13, cutoff: 1200, pan: -0.2 });
      },
    },

    scifi: {
      name: "Sci-fi", line: "A quiet station orbiting somewhere far. Lights blinking in sequence.",
      colors: ["#5ad1ff", "#7a6bff", "#0e2a4a"],
      uses: layersOf(["organ", "vcs", "dbarco", "vlntrem", "piano2_pp", "horn"]),
      bpm: 66, wet: 0.8, dry: 0.6, root: 45, melRoot: 57, level: 3.73,
      scale: [0, 2, 3, 5, 7, 9, 10],
      chords: { isus: [0, 7, 2], VI: [8, 15, 12], iv4: [5, 10, 15], VII: [10, 17, 14] },
      voices: [
        { inst: "organ", range: [52, 64], gain: 0.07, pan: -0.3 },
        { inst: "organ", range: [57, 69], gain: 0.06, pan: 0.3 },
        { inst: "organ", range: [62, 74], gain: 0.05, pan: 0 },
        { inst: "vcs", range: [40, 52], gain: 0.08, pan: -0.2, when: (sec) => sec.i >= 0.35 },
        { inst: "dbarco", bass: true, range: [28, 40], gain: 0.1, pan: 0.1 },
        { inst: "vlntrem", range: [74, 88], gain: 0.022, pan: 0.6, when: (sec) => sec.i >= 0.5 },
      ],
      theme: { A: [[0, 16], [7, 16], [2, 32]] },
      get form() {
        const T = this.theme;
        return [
          { name: "establish", bars: 8, i: 0.18, prog: four("isus", "isus"), pedal: "isus" },
          { name: "A", bars: 8, i: 0.38, prog: four("VI", "isus"), mel: (L, m, put) => put(T.A, 2, { inst: "horn", gain: 0.11, oct: -12, pan: -0.2 }) },
          { name: "B", bars: 8, i: 0.52, prog: four("iv4", "VII") },
          { name: "peak", bars: 8, i: 0.62, prog: four("VI", "VII"), mel: (L, m, put) => put(T.A, 0, { inst: "vcs", gain: 0.1, pan: -0.25 }) },
          { name: "release", bars: 8, i: 0.25, prog: four("isus", "isus"), pedal: "isus" },
        ];
      },
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar) {
        // a slow clock: two piano notes a fifth apart, always the same, as the harmony moves under them
        const m = this, st = s % 16;
        if (st === 0 || st === 8) felt(L, m.root + 24 + (st ? 7 : 0), t, { gain: 0.05 + 0.05 * L.tension, cutoff: 2200, pan: st ? 0.3 : -0.3 });
        sparks(L, m, t, s, bar, 0.03, 81);
      },
    },

    neon: {
      name: "Neon night", line: "City lights sliding past a taxi window at 2 a.m.",
      colors: ["#ff4fd8", "#41e6ff", "#2a0a4a"],
      uses: layersOf(["piano2_pp", "organ", "dbpizz_p", "kick", "vlas", "vcs"]),
      bpm: 88, wet: 0.5, dry: 0.75, root: 52, melRoot: 64, level: 2.43,
      scale: [0, 2, 3, 5, 7, 8, 10],
      chords: { i: [0, 7, 3], VI: [8, 15, 12], III: [3, 10, 7], VII: [10, 17, 14] },
      voices: [
        { inst: "organ", range: [55, 67], gain: 0.05, pan: -0.25 },
        { inst: "organ", range: [59, 71], gain: 0.04, pan: 0.25 },
        { inst: "vlas", range: [60, 72], gain: 0.06, pan: 0.3, when: (sec) => sec.i >= 0.5 },
        { inst: "vcs", bass: true, range: [40, 52], gain: 0.07, pan: -0.1, when: (sec) => sec.i >= 0.35 },
      ],
      theme: { A: [[7, 16], [10, 8], [12, 24]], B: [[3, 16], [2, 16]] },
      get form() {
        const T = this.theme, va = { inst: "vlas", gain: 0.09, pan: 0.25 };
        return [
          { name: "intro", bars: 4, i: 0.2, prog: two("i", "VI") },
          { name: "A", bars: 8, i: 0.4, prog: two("i", "VI", "III", "VII") },
          { name: "B", bars: 8, i: 0.55, prog: two("VI", "VII", "i", "i"), mel: (L, m, put) => { put(T.A, 0, va); put(T.B, 4, va); } },
          { name: "peak", bars: 8, i: 0.68, prog: two("i", "VI", "III", "VII"), mel: (L, m, put) => put(T.A, 2, Object.assign({}, va, { oct: 12, inst: "vlas" })) },
          { name: "release", bars: 8, i: 0.28, prog: two("VI", "VII", "i", "i") },
        ];
      },
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar) {
        const m = this, d = L.e.density, st = s % 16, ten = L.tension;
        ostinato(L, m, t, s, bar, { pattern: [0, 2, 1, 2, 0, 2, 1, 3], lo: 59, gain: 0.09, cutoff: 2600 });
        if (s % 2 === 0) play(L, "dbpizz_p", m.root - 24 + bar.chord[0] + (s % 8 === 6 ? 12 : 0), t, { gain: 0.1 + 0.14 * ten, dur: L.sd * 1.8, r: 0.15, pan: 0 });
        if (ten > 0.45 && (st === 0 || st === 8)) play(L, "kick", null, t, { gain: 0.16 * ten * d, human: 0, pan: 0 });
      },
    },

    // noir: composed in score.js (piano, double bass, muted trumpet, brushes)

    mystery: {
      name: "Mystery", line: "A detail nobody else noticed. Follow it quietly.",
      colors: ["#9be37a", "#4a7fb0", "#16242a"],
      uses: layersOf(["piano2_pp", "clar2", "vcs", "vlas", "dbarco", "cellospic", "vlntrem"]),
      bpm: 66, wet: 0.65, dry: 0.75, root: 50, melRoot: 62, level: 3.55,
      scale: [0, 2, 3, 5, 7, 8, 11],
      chords: { i: [0, 7, 3], bVI: [8, 15, 12], bII: [1, 8, 5], V: [7, 14, 11], iv: [5, 12, 8] },
      voices: [
        { inst: "vlntrem", range: [69, 81], gain: 0.02, pan: 0.5, when: (sec) => sec.i >= 0.45 },
        { inst: "vlas", range: [57, 69], gain: 0.06, pan: 0.25, when: (sec) => sec.i >= 0.35 },
        { inst: "vcs", range: [45, 57], gain: 0.08, pan: -0.15 },
        { inst: "dbarco", bass: true, range: [33, 45], gain: 0.08, pan: -0.1, when: (sec) => sec.i >= 0.3 },
      ],
      theme: { A: [[7, 8], [8, 8], [7, 32]], B: [[3, 16], [2, 16], [11, 32]] },
      get form() {
        const T = this.theme, cl = { inst: "clar2", gain: 0.1, oct: -12, pan: 0.3 };
        return [
          { name: "intro", bars: 4, i: 0.2, prog: two("i", "i") },
          { name: "A", bars: 8, i: 0.38, prog: two("i", "bVI", "i", "V"), mel: (L, m, put) => put(T.A, 2, cl) },
          { name: "B", bars: 8, i: 0.5, prog: two("bII", "V", "iv", "V"), mel: (L, m, put) => put(T.B, 2, { inst: "vcs", gain: 0.1, pan: -0.2 }) },
          { name: "peak", bars: 4, i: 0.6, prog: two("bVI", "V"), mel: (L, m, put) => put(T.A, 0, cl) },
          { name: "release", bars: 8, i: 0.28, prog: two("i", "iv", "V", "i") },
        ];
      },
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar) {
        const m = this, ten = L.tension;
        if (s % 4 === 0) play(L, "cellospic", m.root - 12 + bar.chord[0], t, { gain: 0.03 + 0.06 * ten, pan: -0.25 });
        sparks(L, m, t, s, bar, 0.06 + 0.1 * ten, 76);
      },
    },

    spy: {
      name: "Spy", line: "Sunglasses, a borrowed name, and a car waiting downstairs.",
      colors: ["#ffb84a", "#3fa7a0", "#14202a"],
      uses: layersOf(["cellospic", "vlas", "vcs", "dbarco", "horn", "kick", "piano2_pp"]),
      bpm: 112, wet: 0.45, dry: 0.8, root: 52, melRoot: 64, level: 3.48,
      scale: [0, 2, 3, 5, 7, 8, 10],
      chords: { i: [0, 7, 3], bVI: [8, 15, 12], iv: [5, 12, 8], bII: [1, 8, 5] },
      voices: [
        { inst: "vlas", range: [57, 69], gain: 0.06, pan: 0.3, when: (sec) => sec.i >= 0.4 },
        { inst: "vcs", range: [45, 57], gain: 0.07, pan: -0.25, when: (sec) => sec.i >= 0.3 },
        { inst: "dbarco", bass: true, range: [28, 40], gain: 0.09, pan: 0.05 },
      ],
      theme: { A: [[0, 12], [3, 4], [2, 16], [null, 16], [0, 8], [7, 8], [6, 16]], B: [[8, 16], [7, 16]] },
      get form() {
        const T = this.theme, hn = { inst: "horn", gain: 0.12, oct: -12, pan: -0.25 };
        return [
          { name: "intro", bars: 4, i: 0.28, prog: four("i") },
          { name: "A", bars: 8, i: 0.42, prog: two("i", "i", "bVI", "iv"), mel: (L, m, put) => put(T.A, 2, hn) },
          { name: "B", bars: 8, i: 0.52, prog: two("i", "bII", "i", "bVI"), mel: (L, m, put) => put(T.B, 4, hn) },
          { name: "peak", bars: 8, i: 0.68, prog: two("i", "bVI", "iv", "bII"), mel: (L, m, put) => { put(T.A, 0, hn); put(T.B, 4, { inst: "vlas", gain: 0.09, pan: 0.3 }); } },
          { name: "release", bars: 4, i: 0.3, prog: two("i", "i") },
        ];
      },
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar) {
        const m = this, d = L.e.density, st = s % 16, ten = L.tension;
        if (s % 2 === 0) {
          const pat = [0, 0, 7, 0, 0, 7, 0, 3];
          play(L, "cellospic", m.root - 12 + bar.chord[0] + pat[(s / 2) % 8], t, { gain: 0.06 + 0.1 * ten, pan: -0.2 });
        }
        if (ten > 0.5 && st === 0) play(L, "kick", null, t, { gain: 0.14 * ten * d, human: 0, pan: 0 });
        if (st === 12 && R() < 0.3) felt(L, m.root + 24 + pick([3, 7]), t, { gain: 0.06, cutoff: 2600, pan: 0.4 });
      },
    },

    western: {
      name: "Western", line: "Long straight road, dust in the light, a canyon echo.",
      colors: ["#f2a65a", "#c8553d", "#3a2414"],
      uses: layersOf(["harp2", "dbpizz_p", "oboe", "horn", "vcs", "vlas", "dbarco"]),
      bpm: 72, wet: 0.75, dry: 0.7, root: 50, melRoot: 62, level: 2.73,
      scale: [0, 2, 4, 5, 7, 9, 10],
      chords: { I: [0, 7, 4], bVII: [10, 17, 14], IV: [5, 12, 9], v: [7, 14, 10] },
      voices: [
        { inst: "vlas", range: [57, 69], gain: 0.07, pan: 0.25, when: (sec) => sec.i >= 0.4 },
        { inst: "vcs", range: [45, 57], gain: 0.08, pan: -0.2 },
        { inst: "dbarco", bass: true, range: [26, 38], gain: 0.09, pan: 0.05, when: (sec) => sec.i >= 0.3 },
      ],
      theme: { A: [[7, 8], [9, 4], [7, 4], [2, 32]], B: [[0, 8], [7, 24], [5, 8], [4, 24]] },
      get form() {
        const T = this.theme, ob = { inst: "oboe", gain: 0.11, pan: 0.2 }, hn = { inst: "horn", gain: 0.11, oct: -12, pan: -0.3 };
        return [
          { name: "intro", bars: 4, i: 0.18, prog: four("I"), pedal: "I" },
          { name: "A", bars: 8, i: 0.36, prog: two("I", "bVII", "I", "IV"), mel: (L, m, put) => put(T.A, 2, ob) },
          { name: "B", bars: 8, i: 0.5, prog: two("bVII", "IV", "v", "I"), mel: (L, m, put) => put(T.B, 2, hn) },
          { name: "peak", bars: 8, i: 0.62, prog: two("I", "bVII", "IV", "I"), mel: (L, m, put) => { put(T.A, 0, ob); put(T.B, 4, hn); } },
          { name: "release", bars: 8, i: 0.25, prog: two("IV", "I", "bVII", "I") },
        ];
      },
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar) {
        // wide open harp fifths at the start of each harmony, a lonely bass note on one
        const m = this, st = s % 16, ten = L.tension;
        if (st === 0 && bar.b % 2 === 0) strum(L, "harp2", [m.root - 12 + bar.chord[0], m.root - 5 + bar.chord[0], m.root + bar.chord[0], m.root + 7 + bar.chord[0]], t, { gain: 0.1 + 0.05 * ten, spread: 0.06 });
        if (st === 0) play(L, "dbpizz_p", m.root - 24 + bar.chord[0], t, { gain: 0.14 + 0.08 * ten, pan: -0.1 });
        if (st === 8 && ten > 0.4) play(L, "dbpizz_p", m.root - 24 + bar.chord[0] + 7, t, { gain: 0.1 + 0.06 * ten, pan: -0.1 });
      },
    },

    epic: {
      name: "Epic", line: "The road climbs, the clouds open. This is the part they'll remember.",
      colors: ["#ffc65c", "#d9533f", "#1e2a4f"],
      uses: layersOf(["vlns", "vlas", "vcs", "dbarco", "horn", "cellospic", "timpani", "swell"]),
      bpm: 76, wet: 0.65, dry: 0.75, root: 50, melRoot: 50, level: 1.43,
      scale: [0, 2, 3, 5, 7, 8, 10],
      chords: { i: [0, 7, 3], VI: [8, 15, 12], III: [3, 10, 7], VII: [10, 17, 14], iv: [5, 12, 8] },
      voices: [
        { inst: "vlns", range: [67, 84], gain: 0.11, pan: 0.5, when: (sec) => sec.i >= 0.45 },
        { inst: "vlns", range: [62, 77], gain: 0.11, pan: 0.3, when: (sec) => sec.i >= 0.3 },
        { inst: "vlas", range: [55, 69], gain: 0.12, pan: -0.1 },
        { inst: "vcs", range: [45, 59], gain: 0.12, pan: -0.35 },
        { inst: "dbarco", bass: true, range: [28, 42], gain: 0.14, pan: 0.1, when: (sec) => sec.i >= 0.3 },
      ],
      theme: { A: [[0, 8], [7, 16], [5, 4], [3, 4], [2, 32]], B: [[3, 8], [10, 16], [8, 8], [7, 32]] },
      get form() {
        const T = this.theme, hn = { inst: "horn", gain: 0.15, pan: -0.25 };
        return [
          { name: "establish", bars: 4, i: 0.15, prog: four("i"), pedal: "i" },
          { name: "A", bars: 8, i: 0.36, prog: two("i", "VI", "III", "VII"), mel: (L, m, put) => put(T.A, 2, hn) },
          { name: "B", bars: 8, i: 0.48, prog: two("VI", "VII", "iv", "VII"), mel: (L, m, put) => put(T.B, 2, hn) },
          { name: "build", bars: 4, i: 0.62, prog: two("VI", "VII") },
          { name: "peak", bars: 8, i: 0.85, prog: two("i", "VI", "III", "VII"), mel: (L, m, put) => { const vn = { inst: "vlns", gain: 0.12, oct: 12, pan: 0.4 }; put(T.A, 0, vn); put(T.A, 0, hn); put(T.B, 4, vn); put(T.B, 4, hn); } },
          { name: "release", bars: 8, i: 0.3, prog: two("VI", "VII", "i", "i") },
          { name: "breath", bars: 4, i: 0.12, prog: four("i"), pedal: "i" },
        ];
      },
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar) {
        const m = this, d = L.e.density, st = s % 16, ten = L.tension, sec = bar.sec;
        if (ten > 0.4 && s % 2 === 0) {
          const pat = [0, 0, 7, 0, 12, 0, 7, 0];
          play(L, "cellospic", m.root - 12 + bar.chord[0] + pat[(s / 2) % 8], t, { gain: 0.05 + 0.11 * ten, pan: -0.3 + rpan(0.1) });
        }
        if (st === 0 && bar.b % 2 === 0 && sec.i >= 0.35) play(L, "timpani", m.root - 24 + bar.chord[0], t, { gain: 0.14 + 0.14 * ten, pan: 0 });
        if (sec.name === "build" && s % 4 === 0) play(L, "timpani", m.root - 24 + bar.chord[0], t, { gain: 0.05 + 0.04 * bar.b + 0.015 * (st / 4), pan: 0 });
        if (sec.name === "build" && bar.b === 2 && st === 0) play(L, "swell", null, t, { gain: 0.09, pan: rpan(0.3) });
      },
    },

    scary: {
      level: 2.37,
      name: "Scary", line: "Something in the dark just outside the frame.",
      colors: ["#5f8f74", "#2e4a63", "#14261f"],
      uses: ["vcs_p", "dbarco", "vlntrem", "gong", "swell", "harp2", "bells2", "kick"],
      bpm: 60, wet: 0.9, dry: 0.55, root: 37,
      step(L, t, s) {
        const r = this.root, sd = L.sd, d = L.e.density;
        if (s % 64 === 0) {
          hold(L, "dbarco", r, t, 64 * sd + 2, { gain: 0.2, a: 6, r: 6, pan: -0.1, cutoff: 900 });
          hold(L, "vcs_p", r + 13, t + sd * 8, 56 * sd + 2, { gain: 0.11, a: 7, r: 6, pan: 0.3 });
          if (R() < 0.7) chordHold(L, "vlntrem", [r + 30, r + 31, r + 36].map((x) => x + 12), t + sd * 16, sd * 44, { gain: 0.03, a: 7, r: 6, spread: 0.9, cutoff: 3000 });
        }
        if (s % 64 === 32 && R() < 0.5) hold(L, "vcs_p", r + 6, t, 30 * sd, { gain: 0.08, a: 6, r: 5, pan: -0.4 });
        if (R() < 0.01 * d) play(L, "harp2", r + 24 + pick([0, 1, 6, 7]), t, { gain: 0.2, pan: rpan(0.9), cutoff: 1800 });
        if (R() < 0.004 * d) play(L, "bells2", null, t, { gain: 0.08, rate: 0.5, pan: rpan(0.9) });
        if (R() < 0.003 * d) play(L, "gong", null, t, { gain: 0.15, rate: 0.7, pan: rpan(0.4) });
        if (R() < 0.003 * d) play(L, "swell", null, t, { gain: 0.1, pan: rpan(0.5), rate: 0.85 });
        if (R() < 0.004 * d) play(L, "kick", null, t, { gain: 0.25, rate: 0.6, pan: 0 });
      },
    },

    thriller: {
      name: "Thriller", line: "A train you might be followed on. Keep looking ahead.",
      colors: ["#ff4b3e", "#b0233a", "#3a0f12"],
      uses: layersOf(["cellospic", "dbarco", "vcs", "vlas", "vlntrem", "horn", "timpani", "kick", "taps", "swell", "piano2_pp"]),
      bpm: 112, wet: 0.45, dry: 0.85, root: 45, melRoot: 45, level: 2.05,
      scale: [0, 2, 3, 5, 7, 8, 10],
      chords: { i: [0, 7, 3], bVI: [8, 15, 12], bII: [1, 8, 5], V: [7, 14, 11], iv: [5, 12, 8] },
      voices: [
        { inst: "vlntrem", range: [69, 81], gain: 0.03, pan: 0.45, when: (sec) => sec.i >= 0.6 },
        { inst: "vlas", range: [55, 67], gain: 0.07, pan: 0.2, when: (sec) => sec.i >= 0.4 },
        { inst: "vcs", range: [45, 57], gain: 0.09, pan: -0.2 },
        { inst: "dbarco", bass: true, range: [28, 40], gain: 0.12, pan: 0 },
      ],
      theme: { A: [[0, 16], [8, 16], [7, 32]], B: [[3, 16], [2, 16], [0, 32]] },
      get form() {
        const T = this.theme, hn = { inst: "horn", gain: 0.14, pan: -0.25 };
        return [
          { name: "intro", bars: 4, i: 0.25, prog: four("i") },
          { name: "A", bars: 8, i: 0.42, prog: two("i", "bVI", "i", "V"), mel: (L, m, put) => put(T.A, 2, hn) },
          { name: "B", bars: 8, i: 0.52, prog: two("bII", "V", "iv", "V"), mel: (L, m, put) => put(T.B, 2, hn) },
          { name: "build", bars: 4, i: 0.68, prog: two("bVI", "V") },
          { name: "peak", bars: 8, i: 0.85, prog: two("i", "bVI", "bII", "V"), mel: (L, m, put) => { put(T.A, 0, hn); put(T.A, 4, { inst: "vlas", gain: 0.1, oct: 12, pan: 0.3 }); } },
          { name: "release", bars: 4, i: 0.35, prog: two("i", "i") },
        ];
      },
      ost: [0, 0, 12, 0, 0, 12, 0, 7, 0, 0, 12, 0, 0, 12, 7, 12],
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar) {
        const m = this, d = L.e.density, st = s % 16, ten = L.tension, sec = bar.sec;
        play(L, "cellospic", m.root - 12 + bar.chord[0] + m.ost[st], t, { gain: (st % 4 === 0 ? 0.09 : 0.06) + 0.1 * ten, pan: -0.15 });
        if (s % 2 === 0) play(L, "taps", null, t, { gain: (0.008 + 0.02 * ten) * d, rate: 1.4, pan: -0.3 });
        if (st === 0) play(L, "kick", null, t, { gain: 0.07 + 0.13 * ten, human: 0, pan: 0 });
        if (st === 3) play(L, "kick", null, t, { gain: 0.04 + 0.08 * ten, human: 0, pan: 0 });
        if (sec.name === "build" && s % 4 === 0) play(L, "timpani", m.root - 24 + bar.chord[0], t, { gain: 0.05 + 0.04 * bar.b, pan: 0 });
        if (bar.b === 0 && st === 0 && sec.i >= 0.45) play(L, "timpani", m.root - 24 + bar.chord[0], t, { gain: 0.2, pan: 0 });
        if (sec.name === "build" && bar.b === 2 && st === 0) play(L, "swell", null, t, { gain: 0.09, pan: rpan(0.3) });
        if (st === 8 && R() < 0.15 + 0.2 * ten) felt(L, m.root + 36 + pick([0, 7]), t, { gain: 0.05, cutoff: 3000, pan: 0.4 });
      },
    },
  };

  const ORDER = ["dreamy", "lovely", "happy", "wonder", "fairytale", "melancholy", "scifi", "neon", "noir", "mystery", "spy", "western", "epic", "scary", "thriller"];

  /* ---------- engine ---------- */
  class Engine {
    constructor(ctx, bank) {
      this.ctx = ctx;
      this.bank = bank;
      this.density = 1;
      this.out = ctx.createGain();           // play / pause fader
      this.master = ctx.createGain();        // presence (intensity)
      const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 30;
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -18; this.comp.ratio.value = 2.5;
      this.comp.attack.value = 0.04; this.comp.release.value = 0.5; this.comp.knee.value = 14;
      // reverb send: no low-end mud and no fizz into the hall
      const conv = ctx.createConvolver();
      conv.buffer = makeIR(ctx, 4.2, 2.6);
      const rhp = ctx.createBiquadFilter(); rhp.type = "highpass"; rhp.frequency.value = 170; rhp.Q.value = 0.5;
      const rlp = ctx.createBiquadFilter(); rlp.type = "lowpass"; rlp.frequency.value = 8000; rlp.Q.value = 0.5;
      this.reverb = ctx.createGain();
      this.reverb.connect(rhp); rhp.connect(rlp); rlp.connect(conv);
      this.dry = ctx.createGain();
      this.dry.connect(hp); conv.connect(hp);
      hp.connect(this.master); this.master.connect(this.comp); this.comp.connect(this.out);
      this.layers = [];
      this.setIntensity(0.5);
    }
    setIntensity(v, at) {
      this.intensity = v;
      const g = 2.5 * (0.06 + 0.94 * Math.pow(v, 1.6));   // 2.5 = make-up gain for the recordings
      this.density = 0.55 + 0.9 * v;
      const t = at == null ? this.ctx.currentTime : at;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(g, t, 0.4);
    }
    // Instruments needed by a mood (decode before adding the layer).
    prepare(key) {
      return this.bank.ensure(this.ctx, MOODS[key].uses);
    }
    release() {
      const need = new Set();
      this.layers.forEach((L) => L.mood.uses.forEach((u) => need.add(u)));
      this.bank.keepOnly([...need]);
    }
    addLayer(key, t, fade) {
      const ctx = this.ctx, mood = MOODS[key];
      const L = {
        e: this, ctx, key, mood, t0: t, next: t, s: 0, ci: 0, ch: mood.chords ? mood.chords[0] : [0],
        sd: 60 / mood.bpm / 4, stopped: false,
      };
      L.fade = ctx.createGain();
      L.fade.gain.setValueAtTime(0, t);
      L.fade.gain.linearRampToValueAtTime(1, t + fade);
      L.bus = ctx.createGain();
      L.bus.gain.value = mood.level || 1;
      L.bus.connect(L.fade);
      const dg = ctx.createGain(); dg.gain.value = mood.dry; L.fade.connect(dg); dg.connect(this.dry);
      const wg = ctx.createGain(); wg.gain.value = mood.wet; L.fade.connect(wg); wg.connect(this.reverb);
      if (mood.start) mood.start(L);
      this.layers.push(L);
      return L;
    }
    fadeOutLayer(L, t, fade) {
      if (L.stopped) return;
      L.stopped = true;
      L.end = t + fade;
      L.fade.gain.cancelScheduledValues(t);
      L.fade.gain.setValueAtTime(L.fade.gain.value, t);
      L.fade.gain.linearRampToValueAtTime(0, t + fade);
    }
    schedule(until) {
      for (const L of this.layers) {
        const stopAt = L.stopped ? L.end : Infinity;
        while (L.next < until && L.next < stopAt) {
          L.mood.step(L, L.next, L.s);
          L.s++; L.next += L.sd;
        }
      }
      const now = this.ctx.currentTime, before = this.layers.length;
      this.layers = this.layers.filter((L) => {
        if (L.stopped && now > L.end + 10) { try { L.fade.disconnect(); } catch (e) {} return false; }
        return true;
      });
      if (this.layers.length < before) this.release();
    }
  }

  /* ---------- offline: a seamless loop for lock-screen playback ---------- */
  async function renderLoop(bank, key, intensity, opts = {}) {
    const sr = opts.sampleRate || 32000;
    const W = 10, LEN = opts.seconds || 150, X = 6;
    const total = W + LEN + X + 1;
    const OAC = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    const off = new OAC(2, Math.ceil(sr * total), sr);
    await bank.ensure(opts.decodeCtx || off, MOODS[key].uses);
    const e = new Engine(off, bank);
    e.setIntensity(intensity, 0);
    e.out.connect(off.destination);
    e.addLayer(key, 0, 0.05);
    e.schedule(total);
    const buf = await off.startRendering();
    const N = Math.floor(LEN * sr), w = Math.floor(W * sr), x = Math.floor(X * sr);
    const chans = [0, 1].map((c) => {
      const d = buf.getChannelData(c), out = new Float32Array(N);
      for (let i = 0; i < N; i++) out[i] = d[w + i];
      for (let i = 0; i < x; i++) {
        const a = (i / x) * Math.PI / 2;
        out[i] = d[w + i] * Math.sin(a) + d[w + N + i] * Math.cos(a);
      }
      return out;
    });
    return { sampleRate: sr, channels: chans };
  }

  function encodeWAV(sampleRate, channels) {
    const n = channels[0].length, nc = channels.length;
    const buf = new ArrayBuffer(44 + n * nc * 2), v = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, "RIFF"); v.setUint32(4, 36 + n * nc * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nc * 2, true);
    v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true); ws(36, "data"); v.setUint32(40, n * nc * 2, true);
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
    }
    return buf;
  }

  const api = { Engine, Bank, MOODS, ORDER, renderLoop, encodeWAV, lib: { play, hold, bowed, expression, DYN, layersOf, makeIR, voiceOut } };
  root.TripEngine = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
