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
          this.buf[n] = { buffer: b, notes: this.map[n].notes };
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
      else play(L, e.inst, e.midi, t + late, { gain: e.gain * (0.5 + 0.5 * d), dur: len * (e.legato || 0.97), a: e.a || 0.03, r: e.r || 0.35, pan: e.pan });
    }
    if (m.colour) m.colour(L, t, s, bar, bi);
  }
  // Is the melody playing this bar on a given instrument? (colour parts step aside for it)
  const melodyIn = (L, bi, inst) => L.plan.mel.some((e) => e.bar === bi && (!inst || e.inst === inst));

  /* ---------- the moods ---------- */
  // root = MIDI tonic for harmony; melRoot = tonic the theme is written from (same pitch class).
  // chords are semitone offsets from the tonic; themes are [offset, length in steps] (null = rest).
  const MOODS = {
    dreamy: {
      name: "Dreamy", line: "Half-awake, floating, slow light through a window.",
      colors: ["#7f9cff", "#c3a2ff", "#3b3f8f"],
      uses: layersOf(["violins", "violas", "cellos", "flute", "harp", "glock", "bells1"]),
      bpm: 56, wet: 0.8, dry: 0.65, root: 62, melRoot: 62, level: 2.4,
      scale: [0, 2, 4, 6, 7, 9, 11],
      chords: { I: [0, 4, 7, 11], II: [2, 6, 9], vi: [9, 12, 16], iii: [4, 7, 11], V: [7, 11, 14] },
      voices: [
        { inst: "violins", range: [69, 86], gain: 0.13, pan: 0.45, when: (sec) => sec.i >= 0.3 },
        { inst: "violins", range: [62, 79], gain: 0.13, pan: 0.25 },
        { inst: "violas", range: [55, 71], gain: 0.14, pan: -0.25 },
        { inst: "cellos", bass: true, range: [38, 53], gain: 0.16, pan: -0.4 },
      ],
      theme: {
        A: [[7, 6], [11, 2], [14, 8], [12, 4], [11, 4], [9, 8]],
        B: [[7, 4], [9, 4], [6, 8], [4, 12], [null, 4]],
        C: [[7, 4], [9, 4], [11, 8], [12, 16]],
      },
      get form() {
        const T = this.theme, lead = (L) => (L.cycle % 2 ? { inst: "violins", gain: 0.12, pan: 0.15 } : { inst: "flute", gain: 0.13, pan: 0.15 });
        return [
          { name: "establish", bars: 4, i: 0.15, prog: ["I", "I", "II", "II"], pedal: "I",
            mel: (L, m, put) => { put(head(T.A, 3), 1, { inst: "harp", gain: 0.24 }); put(head(T.A, 3), 3, { inst: "harp", gain: 0.2 }); } },
          { name: "theme", bars: 8, i: 0.35, prog: ["I", "II", "vi", "I", "I", "II", "vi", "V"],
            mel: (L, m, put) => { const o = lead(L); put(T.A, 0, o); put(T.B, 2, o); put(T.A, 4, o); put(T.C, 6, o); } },
          { name: "develop", bars: 8, i: 0.5, prog: ["iii", "vi", "II", "V", "iii", "vi", "II", "II"],
            mel: (L, m, put) => { put(seq(T.A, 2, m.scale), 0, { inst: "violins", gain: 0.11, pan: 0.3 });
              put(seq(T.A, -1, m.scale), 4, { inst: "flute", gain: 0.11, pan: -0.1 }); put(T.B, 6, { inst: "harp", gain: 0.2 }); } },
          { name: "peak", bars: 4, i: 0.7, prog: ["I", "II", "vi", "II"],
            mel: (L, m, put) => { put(T.A, 0, { inst: "violins", gain: 0.12, oct: 12, pan: 0.35 }); put(T.A, 0, { inst: "glock", gain: 0.06, oct: 12 });
              put(T.C, 2, { inst: "violins", gain: 0.12, oct: 12, pan: 0.35 }); } },
          { name: "release", bars: 8, i: 0.3, prog: ["I", "II", "I", "II", "vi", "V", "I", "I"],
            mel: (L, m, put) => { put(aug(T.B, 1.5), 1, { inst: "flute", gain: 0.1, pan: 0.2 }); put(head(T.A, 3), 6, { inst: "harp", gain: 0.18 }); } },
          { name: "breath", bars: 4, i: 0.1, prog: ["I", "I", "II", "I"], pedal: "I" },
        ];
      },
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar) {
        const m = this, d = L.e.density;
        if (s % 2 === 0 && R() < (0.03 + 0.12 * L.tension) * d) play(L, "harp", m.root + 12 + pick(bar.safe), t, { gain: 0.13 + 0.08 * L.tension, pan: rpan(0.7) });
        if (s % 8 === 4 && R() < 0.03 * d) play(L, "glock", m.root + 24 + pick(bar.safe), t, { gain: 0.05, pan: rpan(0.8) });
        if (s % (L.plan.len * 16) === 0) play(L, "bells1", null, t, { gain: 0.07, pan: rpan(0.6), rate: 0.9 });
      },
    },

    lovely: {
      name: "Lovely", line: "Warm, tender, someone you are glad is next to you.",
      colors: ["#ff9fb2", "#ffcb9a", "#8a3d5c"],
      uses: layersOf(["piano", "violins", "violas", "cellos", "flute"]),
      bpm: 66, wet: 0.5, dry: 0.85, root: 53, melRoot: 65, level: 2.82,
      scale: [0, 2, 4, 5, 7, 9, 11],
      chords: { I: [0, 4, 7], vi: [9, 12, 16], IV: [5, 9, 12], V: [7, 11, 14], ii: [2, 5, 9], iii: [4, 7, 11] },
      voices: [
        { inst: "violins", range: [65, 81], gain: 0.1, pan: 0.4, when: (sec) => sec.i >= 0.4 },
        { inst: "violas", range: [57, 70], gain: 0.11, pan: 0.15 },
        { inst: "violas", range: [52, 64], gain: 0.1, pan: -0.15 },
        { inst: "cellos", bass: true, range: [36, 50], gain: 0.14, pan: -0.35 },
      ],
      theme: {
        A: [[0, 4], [4, 4], [7, 6], [9, 2], [7, 8], [4, 8]],
        B: [[5, 4], [4, 4], [2, 4], [4, 4], [2, 16]],
        C: [[9, 4], [7, 4], [4, 4], [2, 4], [0, 16]],
      },
      get form() {
        const T = this.theme, pno = { inst: "piano", gain: 0.24, pan: 0.1 };
        return [
          { name: "intro", bars: 4, i: 0.2, prog: ["I", "IV", "I", "IV"], mel: (L, m, put) => put(head(T.A, 3), 2, pno) },
          { name: "theme", bars: 8, i: 0.38, prog: ["I", "vi", "IV", "V", "I", "vi", "ii", "V"],
            mel: (L, m, put) => { put(T.A, 0, pno); put(T.B, 2, pno); put(T.A, 4, pno); put(T.C, 6, pno); } },
          { name: "develop", bars: 8, i: 0.5, prog: ["vi", "iii", "IV", "I", "vi", "iii", "ii", "V"],
            mel: (L, m, put) => { put(seq(T.A, -2, m.scale), 0, { inst: "flute", gain: 0.11, pan: 0.3 }); put(seq(T.B, 1, m.scale), 4, pno); } },
          { name: "peak", bars: 4, i: 0.62, prog: ["IV", "V", "I", "vi"],
            mel: (L, m, put) => { put(T.A, 0, { inst: "violins", gain: 0.12, pan: 0.35 }); put(T.C, 2, { inst: "violins", gain: 0.12, pan: 0.35 }); } },
          { name: "release", bars: 8, i: 0.3, prog: ["IV", "I", "ii", "V", "IV", "I", "V", "I"],
            mel: (L, m, put) => { put(aug(T.A, 1.5), 1, Object.assign({}, pno, { gain: 0.2 })); } },
          { name: "breath", bars: 4, i: 0.15, prog: ["I", "IV", "I", "I"] },
        ];
      },
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar, bi) {
        const m = this, st = s % 16;
        // left hand: root on 1, open fifth/tenth on 3, a little softer while the theme sings
        const soft = melodyIn(L, bi, "piano") ? 0.7 : 1;
        if (st === 0) play(L, "piano", m.root - 12 + bar.chord[0], t, { gain: 0.16 * soft, pan: -0.2 });
        if (st === 8) play(L, "piano", m.root + bar.safe[1 % bar.safe.length], t + 0.02, { gain: 0.1 * soft, pan: -0.1 });
        if (st === 12 && R() < 0.4) play(L, "piano", m.root + 7 + bar.chord[0], t + 0.02, { gain: 0.07 * soft, pan: -0.1 });
      },
    },

    happy: {
      name: "Happy", line: "Windows down, sun on the dashboard, no hurry.",
      colors: ["#ffd36b", "#7fe0c2", "#e2793f"],
      uses: layersOf(["marimba", "cellopizz", "vlnpizz", "shaker", "tamb", "kick", "violins", "violas", "flute"]),
      bpm: 100, wet: 0.28, dry: 0.85, root: 55, melRoot: 67, level: 1.5,
      scale: [0, 2, 4, 5, 7, 9, 11],
      chords: { I: [0, 4, 7], V: [7, 11, 14], vi: [9, 12, 16], IV: [5, 9, 12], ii: [2, 5, 9] },
      voices: [
        { inst: "violins", range: [67, 83], gain: 0.06, pan: 0.4, when: (sec) => sec.i >= 0.5 },
        { inst: "violas", range: [57, 72], gain: 0.06, pan: -0.2, when: (sec) => sec.i >= 0.4 },
      ],
      theme: {
        A: [[7, 2], [9, 2], [11, 4], [14, 4], [11, 4], [12, 4], [11, 2], [9, 2], [7, 8]],
        B: [[4, 2], [7, 2], [9, 4], [11, 4], [9, 4], [7, 8], [null, 8]],
        C: [[12, 4], [11, 4], [9, 4], [11, 4], [7, 16]],
      },
      get form() {
        const T = this.theme, lead = (L) => (L.cycle % 2 ? { inst: "flute", gain: 0.11, pan: 0.2 } : { inst: "marimba", gain: 0.22, pan: 0.2 });
        return [
          { name: "intro", bars: 4, i: 0.25, prog: ["I", "I", "IV", "V"] },
          { name: "theme", bars: 8, i: 0.45, prog: ["I", "V", "vi", "IV", "I", "V", "IV", "I"],
            mel: (L, m, put) => { const o = lead(L); put(T.A, 0, o); put(T.B, 2, o); put(T.A, 4, o); put(T.C, 6, o); } },
          { name: "develop", bars: 8, i: 0.55, prog: ["vi", "IV", "I", "V", "vi", "IV", "ii", "V"],
            mel: (L, m, put) => { put(seq(T.A, -2, m.scale), 0, { inst: "vlnpizz", gain: 0.16, pan: -0.2 }); put(seq(T.A, 1, m.scale), 4, lead(L)); } },
          { name: "peak", bars: 8, i: 0.75, prog: ["I", "V", "vi", "IV", "I", "V", "IV", "I"],
            mel: (L, m, put) => { const o = lead(L); put(T.A, 0, o); put(T.B, 2, o); put(T.A, 4, o); put(T.C, 6, o);
              put(T.A, 4, { inst: "vlnpizz", gain: 0.12, oct: 12, pan: -0.3 }); } },
          { name: "release", bars: 4, i: 0.35, prog: ["IV", "I", "V", "I"] },
          { name: "breath", bars: 4, i: 0.2, prog: ["I", "I", "IV", "I"] },
        ];
      },
      arp: [0, 1, 2, 1],
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar, bi) {
        const m = this, d = L.e.density, st = s % 16, ten = L.tension;
        const busy = melodyIn(L, bi, "marimba");
        if (!busy && R() < (st % 4 === 0 ? 0.5 : 0.2) * d * (0.4 + ten))
          play(L, "marimba", m.root + bar.safe[m.arp[(s >> 1) % 4] % bar.safe.length], t, { gain: 0.12, pan: (st / 15) - 0.5 });
        if (st === 0 || st === 6 || st === 8) play(L, "cellopizz", m.root - 12 + bar.chord[0] + (st === 6 ? 7 : 0), t, { gain: 0.26 + 0.08 * ten, pan: -0.1 });
        if ((st === 4 || st === 12) && ten > 0.3) strum(L, "vlnpizz", bar.safe.map((n) => m.root + n), t, { gain: 0.07, spread: 0.012 });
        if (ten > 0.35 && s % 8 === 0) play(L, "kick", null, t, { gain: 0.18 * ten * d, pan: 0, human: 0 });
        if (s % 2 === 1) play(L, "shaker", null, t, { gain: (0.02 + 0.05 * ten) * d, pan: 0.3 });
        if ((st === 4 || st === 12) && ten > 0.5) play(L, "tamb", null, t, { gain: 0.05 * d, pan: -0.35 });
      },
    },

    wonder: {
      name: "Wonder", line: "Mountains turning gold. The whole world, wider than you remembered.",
      colors: ["#8fe3d4", "#ffe2a3", "#2f6f8f"],
      uses: layersOf(["harp", "violins", "violas", "cellos", "horn", "glock", "flute"]),
      bpm: 72, wet: 0.7, dry: 0.7, root: 52, melRoot: 52, level: 2.23,
      scale: [0, 2, 4, 5, 7, 9, 11],
      chords: { I: [0, 4, 7], IV: [5, 9, 12], vi: [9, 12, 16], V: [7, 11, 14], iii: [4, 7, 11], bVII: [10, 14, 17] },
      voices: [
        { inst: "violins", range: [71, 88], gain: 0.11, pan: 0.5, when: (sec) => sec.i >= 0.4 },
        { inst: "violins", range: [64, 79], gain: 0.11, pan: 0.3 },
        { inst: "violas", range: [55, 71], gain: 0.12, pan: -0.15 },
        { inst: "cellos", bass: true, range: [40, 52], gain: 0.15, pan: -0.4 },
      ],
      theme: {
        A: [[0, 4], [7, 4], [12, 8], [11, 4], [9, 4], [7, 8]],
        B: [[4, 4], [7, 4], [9, 8], [7, 4], [4, 4], [2, 8]],
        C: [[0, 4], [7, 4], [12, 4], [14, 4], [16, 8], [12, 8]],
      },
      get form() {
        const T = this.theme, hn = { inst: "horn", gain: 0.15, pan: -0.25 };
        return [
          { name: "establish", bars: 4, i: 0.2, prog: ["I", "I", "IV", "IV"], pedal: "I" },
          { name: "theme", bars: 8, i: 0.4, prog: ["I", "IV", "vi", "V", "I", "IV", "bVII", "I"],
            mel: (L, m, put) => { put(T.A, 0, hn); put(T.B, 2, hn); put(T.A, 4, hn); put(T.C, 6, { inst: "violins", gain: 0.11, oct: 12, pan: 0.35 }); } },
          { name: "develop", bars: 8, i: 0.5, prog: ["vi", "iii", "IV", "I", "vi", "IV", "bVII", "V"],
            mel: (L, m, put) => { put(seq(T.A, 2, m.scale), 0, { inst: "flute", gain: 0.11, oct: 12, pan: 0.3 }); put(seq(T.B, -1, m.scale), 4, hn); } },
          { name: "peak", bars: 8, i: 0.8, prog: ["I", "IV", "vi", "V", "I", "bVII", "IV", "I"],
            mel: (L, m, put) => { const vn = { inst: "violins", gain: 0.13, oct: 12, pan: 0.4 };
              [[T.A, 0], [T.B, 2], [T.A, 4], [T.C, 6]].forEach(([mo, b]) => { put(mo, b, vn); put(mo, b, mo === T.C ? Object.assign({}, hn, { oct: -12 }) : hn); }); } },
          { name: "release", bars: 8, i: 0.35, prog: ["IV", "I", "vi", "V", "IV", "I", "IV", "I"],
            mel: (L, m, put) => put(aug(T.A, 1.5), 2, { inst: "flute", gain: 0.1, oct: 12, pan: 0.25 }) },
          { name: "breath", bars: 4, i: 0.15, prog: ["I", "I", "IV", "I"], pedal: "I" },
        ];
      },
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar) {
        const m = this, d = L.e.density, st = s % 16, ten = L.tension;
        if (st < 10 && R() < (0.25 + 0.5 * ten) * d) {
          const tones = bar.safe.concat(bar.safe.map((n) => n + 12));
          play(L, "harp", m.root + 12 + tones[st % tones.length], t, { gain: 0.12 + 0.08 * ten, pan: st / 9 - 0.5 });
        }
        if (ten > 0.6 && s % 4 === 0 && R() < 0.05 * d) play(L, "glock", m.root + 36 + pc12(pick(bar.safe)), t, { gain: 0.06, pan: rpan(0.8) });
      },
    },

    fairytale: {
      name: "Fairy tale", line: "Once upon a time, a little lantern in a big dark forest.",
      colors: ["#f5b8ff", "#a9d8ff", "#4b3a8f"],
      uses: layersOf(["basspizz", "vlnpizz", "glock", "flute", "violas", "triangle"]),
      bpm: 126, barSteps: 12, wet: 0.5, dry: 0.8, root: 60, melRoot: 72, level: 1.82,
      scale: [0, 2, 4, 5, 7, 9, 11],
      chords: { I: [0, 4, 7], vi: [9, 12, 16], IV: [5, 9, 12], V: [7, 11, 14], ii: [2, 5, 9] },
      voices: [
        { inst: "violas", range: [55, 67], gain: 0.05, pan: -0.2, when: (sec) => sec.i >= 0.3 },
        { inst: "violas", range: [60, 72], gain: 0.05, pan: 0.2, when: (sec) => sec.i >= 0.45 },
      ],
      theme: {   // 3/4: 12 steps a bar
        A: [[0, 4], [4, 4], [7, 4], [9, 6], [7, 2], [4, 4], [5, 4], [4, 4], [2, 4], [0, 12]],
        B: [[7, 4], [9, 4], [11, 4], [12, 6], [11, 2], [9, 4], [7, 4], [5, 4], [4, 4], [2, 12]],
        C: [[4, 4], [5, 4], [7, 4], [9, 8], [7, 4], [5, 4], [4, 4], [2, 4], [0, 12]],
      },
      get form() {
        const T = this.theme, lead = (L) => (L.cycle % 2 ? { inst: "flute", gain: 0.12, oct: -12, pan: 0.2 } : { inst: "glock", gain: 0.11, pan: 0.2 });
        return [
          { name: "intro", bars: 8, i: 0.2, prog: ["I", "I", "IV", "I", "I", "IV", "V", "I"] },
          { name: "theme", bars: 16, i: 0.4, prog: ["I", "vi", "IV", "V", "I", "vi", "ii", "V", "I", "vi", "IV", "V", "IV", "V", "I", "I"],
            mel: (L, m, put) => { const o = lead(L); put(T.A, 0, o); put(T.B, 4, o); put(T.A, 8, o); put(T.C, 12, o); } },
          { name: "develop", bars: 16, i: 0.5, prog: ["vi", "IV", "I", "V", "vi", "IV", "ii", "V", "IV", "V", "I", "vi", "IV", "ii", "V", "V"],
            mel: (L, m, put) => { put(seq(T.A, -2, m.scale), 0, { inst: "flute", gain: 0.11, oct: -12, pan: -0.2 }); put(seq(T.B, 1, m.scale), 8, { inst: "glock", gain: 0.1 }); } },
          { name: "peak", bars: 8, i: 0.62, prog: ["IV", "V", "I", "vi", "IV", "V", "I", "I"],
            mel: (L, m, put) => { put(T.A, 0, { inst: "flute", gain: 0.12, oct: -12, pan: 0.2 }); put(T.A, 0, { inst: "glock", gain: 0.08 }); put(T.C, 4, { inst: "flute", gain: 0.12, oct: -12, pan: 0.2 }); } },
          { name: "release", bars: 16, i: 0.3, prog: ["IV", "I", "ii", "V", "IV", "I", "V", "I"],
            mel: (L, m, put) => put(aug(T.A, 1.5), 2, { inst: "glock", gain: 0.09 }) },
          { name: "breath", bars: 8, i: 0.15, prog: ["I", "I", "IV", "I"] },
        ];
      },
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar, bi) {
        const m = this, st = s % 12, ten = L.tension;
        if (st === 0) play(L, "basspizz", m.root - 24 + bar.chord[0], t, { gain: 0.24 + 0.08 * ten, pan: -0.1 });
        if (st === 4 || st === 8) strum(L, "vlnpizz", bar.safe.map((n) => m.root + n), t, { gain: 0.05 + 0.03 * ten, spread: 0.01 });
        if (bar.b === 0 && st === 0 && bar.sec.i >= 0.4) play(L, "triangle", null, t, { gain: 0.05, pan: 0.5 });
      },
    },

    melancholy: {
      name: "Melancholy", line: "Rain on the window. The last day of the trip.",
      colors: ["#8aa0b8", "#5d6f8a", "#1d2738"],
      uses: layersOf(["piano", "cellos", "violas", "clarinet"]),
      bpm: 60, wet: 0.75, dry: 0.75, root: 57, melRoot: 69, level: 3.24,
      scale: [0, 2, 3, 5, 7, 8, 10],
      chords: { i: [0, 3, 7], VI: [8, 12, 15], iv: [5, 8, 12], v: [7, 10, 14], III: [3, 7, 10], VII: [10, 14, 17] },
      voices: [
        { inst: "violas", range: [57, 69], gain: 0.07, pan: 0.2, when: (sec) => sec.i >= 0.25 },
        { inst: "cellos", range: [48, 62], gain: 0.09, pan: -0.1, when: (sec) => sec.i >= 0.3 },
        { inst: "cellos", bass: true, range: [36, 50], gain: 0.11, pan: -0.3 },
      ],
      theme: {
        A: [[7, 4], [3, 4], [2, 4], [0, 4], [3, 8], [null, 8]],
        B: [[8, 6], [7, 2], [5, 4], [3, 4], [2, 16]],
        C: [[0, 4], [3, 4], [7, 4], [12, 4], [10, 6], [8, 2], [7, 8]],
      },
      get form() {
        const T = this.theme, pno = { inst: "piano", gain: 0.24, pan: 0.05 };
        return [
          { name: "intro", bars: 4, i: 0.15, prog: ["i", "VI", "iv", "v"], mel: (L, m, put) => put(head(T.A, 4), 2, Object.assign({}, pno, { gain: 0.18 })) },
          { name: "theme", bars: 8, i: 0.3, prog: ["i", "VI", "iv", "v", "i", "VI", "III", "v"],
            mel: (L, m, put) => { put(T.A, 0, pno); put(T.B, 2, pno); put(T.A, 4, pno); put(T.C, 6, pno); } },
          { name: "develop", bars: 8, i: 0.4, prog: ["VI", "III", "VII", "i", "VI", "III", "iv", "v"],
            mel: (L, m, put) => { put(T.A, 0, { inst: "clarinet", gain: 0.11, oct: -12, pan: 0.3 }); put(seq(T.B, 2, m.scale), 4, { inst: "clarinet", gain: 0.11, oct: -12, pan: 0.3 }); } },
          { name: "peak", bars: 4, i: 0.55, prog: ["VI", "VII", "i", "i"],
            mel: (L, m, put) => { put(T.C, 0, { inst: "cellos", gain: 0.12, oct: -12, pan: -0.2 }); put(T.C, 0, Object.assign({}, pno, { oct: 12, gain: 0.12 })); } },
          { name: "release", bars: 8, i: 0.25, prog: ["iv", "i", "VI", "v", "iv", "i", "v", "i"],
            mel: (L, m, put) => put(aug(T.A, 1.5), 1, Object.assign({}, pno, { gain: 0.2 })) },
          { name: "breath", bars: 4, i: 0.1, prog: ["i", "i", "VI", "i"] },
        ];
      },
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar) {
        const m = this, st = s % 16;
        if (st === 0) play(L, "piano", m.root - 24 + bar.chord[0], t, { gain: 0.18, pan: -0.15 });
        if (st === 6 && R() < 0.6) play(L, "piano", m.root - 12 + pick(bar.safe), t + 0.02, { gain: 0.08, pan: -0.05 });
      },
    },

    scifi: {
      name: "Sci-fi", line: "A quiet station orbiting somewhere far. Lights blinking in sequence.",
      colors: ["#5ad1ff", "#7a6bff", "#0e2a4a"],
      uses: layersOf(["organ", "piano", "vlntrem", "glock", "bells2"]),
      bpm: 84, wet: 0.7, dry: 0.7, root: 57, melRoot: 69, level: 3.88,
      scale: [0, 2, 3, 5, 7, 9, 10],
      chords: { i: [0, 3, 7], VI: [8, 12, 15], VII: [10, 14, 17], IV: [5, 9, 12], iv: [5, 8, 12] },
      voices: [
        { inst: "organ", range: [52, 64], gain: 0.08, pan: -0.3 },
        { inst: "organ", range: [57, 69], gain: 0.08, pan: 0.3 },
        { inst: "organ", range: [62, 74], gain: 0.07, pan: 0 },
        { inst: "organ", bass: true, range: [33, 45], gain: 0.1, pan: 0 },
        { inst: "vlntrem", range: [69, 84], gain: 0.035, pan: 0.6, when: (sec) => sec.i >= 0.55 },
      ],
      theme: {
        A: [[0, 8], [7, 8], [12, 8], [10, 4], [7, 4]],
        B: [[3, 8], [5, 8], [7, 16]],
        C: [[12, 8], [15, 8], [14, 16]],
      },
      get form() {
        const T = this.theme, pno = { inst: "piano", gain: 0.16, pan: 0.2 };
        return [
          { name: "establish", bars: 8, i: 0.2, prog: ["i", "i", "VI", "VI", "VII", "VII", "i", "i"] },
          { name: "theme", bars: 8, i: 0.4, prog: ["i", "VI", "VII", "IV", "i", "VI", "iv", "VII"],
            mel: (L, m, put) => { put(T.A, 0, pno); put(T.B, 2, pno); put(T.A, 4, pno); put(T.C, 6, pno); } },
          { name: "develop", bars: 8, i: 0.5, prog: ["VI", "VII", "i", "IV", "VI", "VII", "iv", "iv"],
            mel: (L, m, put) => { put(head(T.A, 3), 1, { inst: "glock", gain: 0.06, pan: 0.5 }); put(seq(head(T.A, 3), 2, m.scale), 5, { inst: "glock", gain: 0.06, pan: -0.5 }); } },
          { name: "peak", bars: 8, i: 0.65, prog: ["i", "VI", "VII", "IV", "i", "VI", "VII", "i"],
            mel: (L, m, put) => { put(T.A, 0, pno); put(T.C, 2, pno); put(T.A, 4, Object.assign({}, pno, { oct: 12 })); put(T.C, 6, pno); } },
          { name: "release", bars: 8, i: 0.3, prog: ["VI", "VII", "i", "i", "VI", "iv", "i", "i"],
            mel: (L, m, put) => put(aug(T.B, 1.5), 2, pno) },
          { name: "breath", bars: 4, i: 0.15, prog: ["i", "i", "VI", "i"] },
        ];
      },
      arp: [0, 1, 2, 1, 3, 1, 2, 1],
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar, bi) {
        const m = this, st = s % 16, ten = L.tension, d = L.e.density;
        // a quiet clockwork of piano eighths over the voice-led chord, thinner when the theme plays
        const busy = melodyIn(L, bi, "piano");
        if (s % 2 === 0 && R() < (busy ? 0.25 : 0.55) + 0.35 * ten) {
          const v = bar.voicing.slice(0, 3);
          play(L, "piano", v[m.arp[(s / 2) % 8] % v.length] + 12, t, { gain: 0.06 + (st === 0 ? 0.03 : 0), dur: L.sd * 3, r: 0.8, pan: (s % 4 ? 0.3 : -0.3) });
        }
        if (R() < 0.008 * d) for (let i = 0; i < 1 + Math.floor(R() * 3); i++) play(L, "glock", m.root + 36 + pc12(pick(bar.safe)), t + i * 0.13, { gain: 0.04, dur: 0.15, r: 0.2, pan: rpan(0.9) });
        if (s % (L.plan.len * 16) === 32) play(L, "bells2", null, t, { gain: 0.06, rate: 0.75, pan: rpan(0.6) });
      },
    },

    neon: {
      name: "Neon night", line: "City lights sliding past a taxi window at 2 a.m.",
      colors: ["#ff4fd8", "#41e6ff", "#2a0a4a"],
      uses: layersOf(["piano", "basspizz", "kick", "snare", "shaker", "violins", "violas", "straight"]),
      bpm: 96, wet: 0.45, dry: 0.75, root: 52, melRoot: 64, level: 1.33,
      scale: [0, 2, 3, 5, 7, 8, 10],
      chords: { i: [0, 3, 7], VI: [8, 12, 15], III: [3, 7, 10], VII: [10, 14, 17] },
      voices: [
        { inst: "violins", range: [64, 79], gain: 0.05, pan: 0.4, when: (sec) => sec.i >= 0.4 },
        { inst: "violas", range: [55, 70], gain: 0.05, pan: -0.3 },
        { inst: "violas", range: [52, 64], gain: 0.04, pan: 0.2, when: (sec) => sec.i >= 0.5 },
      ],
      theme: {
        A: [[7, 4], [10, 4], [12, 8], [15, 4], [12, 4], [10, 8]],
        B: [[7, 4], [5, 4], [3, 8], [0, 16]],
        C: [[12, 4], [10, 4], [12, 4], [15, 4], [14, 8], [12, 8]],
      },
      get form() {
        const T = this.theme, tp = { inst: "straight", gain: 0.12, pan: 0.2 };
        return [
          { name: "intro", bars: 4, i: 0.22, prog: ["i", "VI", "III", "VII"] },
          { name: "theme", bars: 8, i: 0.45, prog: ["i", "VI", "III", "VII", "i", "VI", "III", "VII"],
            mel: (L, m, put) => { put(T.A, 0, tp); put(T.B, 2, tp); put(T.A, 4, tp); put(T.C, 6, tp); } },
          { name: "develop", bars: 8, i: 0.5, prog: ["VI", "VII", "i", "i", "VI", "VII", "III", "VII"] },
          { name: "peak", bars: 8, i: 0.7, prog: ["i", "VI", "III", "VII", "i", "VI", "III", "VII"],
            mel: (L, m, put) => { put(T.C, 0, tp); put(T.A, 2, tp); put(T.C, 4, tp); put(T.B, 6, tp); put(T.C, 4, { inst: "violins", gain: 0.08, pan: 0.4 }); } },
          { name: "release", bars: 4, i: 0.35, prog: ["VI", "VII", "i", "i"] },
          { name: "breath", bars: 4, i: 0.18, prog: ["i", "VI", "III", "VII"] },
        ];
      },
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar) {
        const m = this, sd = L.sd, d = L.e.density, st = s % 16, ten = L.tension;
        if (s % 2 === 0) play(L, "basspizz", m.root - 24 + bar.chord[0] + (s % 4 === 2 ? 12 : 0), t, { gain: 0.14 + 0.16 * ten, dur: sd * 1.8, r: 0.15, pan: 0 });
        if (s % 4 === 2 && R() < 0.4 + 0.5 * ten) bar.voicing.slice(0, 3).forEach((n, i) => play(L, "piano", n + 12, t, { gain: 0.06, dur: sd * 1.4, r: 0.12, pan: i * 0.2 - 0.2 }));
        if (ten > 0.3) {
          if (s % 4 === 0) play(L, "kick", null, t, { gain: 0.24 * ten * d, human: 0, pan: 0 });
          if (st === 4 || st === 12) play(L, "snare", null, t, { gain: 0.1 * ten * d, pan: 0.05 });
        }
        play(L, "shaker", null, t, { gain: (s % 2 ? 0.04 : 0.025) * d * (0.4 + ten), pan: 0.3 });
      },
    },

    noir: {
      name: "Noir", line: "Paris, 3 a.m. Wet cobblestones and a muted trumpet somewhere.",
      colors: ["#c9b38a", "#7d6a52", "#1a1714"],
      uses: layersOf(["harmon", "basspizz", "taps", "piano", "cymbal", "cellos"]),
      bpm: 66, wet: 0.55, dry: 0.85, root: 50, melRoot: 62, swing: 0.33, level: 1.35,
      scale: [0, 2, 3, 5, 7, 9, 10],
      chords: { Dm9: [0, 3, 7, 10, 14], G7: [5, 9, 12, 15], Bb: [8, 12, 15, 19], A7: [7, 11, 14, 17], Eb: [1, 5, 8, 12] },
      voices: [
        { inst: "piano", silent: true, range: [53, 62] },
        { inst: "piano", silent: true, range: [57, 66] },
        { inst: "piano", silent: true, range: [60, 70] },
        { inst: "piano", silent: true, range: [64, 74] },
        { inst: "cellos", bass: true, range: [38, 50], gain: 0.07, pan: -0.25, when: (sec) => sec.i >= 0.45 },
      ],
      theme: {
        A: [[7, 6], [5, 2], [3, 4], [0, 4], [null, 4], [3, 2], [5, 2], [7, 8]],
        B: [[10, 4], [9, 2], [7, 2], [5, 8], [3, 6], [2, 2], [0, 8]],
        C: [[12, 8], [10, 4], [9, 4], [7, 16]],
      },
      get form() {
        const T = this.theme, tp = { inst: "harmon", gain: 0.2, pan: 0.18, legato: 0.92 };
        return [
          { name: "intro", bars: 4, i: 0.2, prog: ["Dm9", "Dm9", "Eb", "Dm9"] },
          { name: "theme", bars: 8, i: 0.4, prog: ["Dm9", "G7", "Dm9", "A7", "Dm9", "G7", "Bb", "A7"],
            mel: (L, m, put) => { put(T.A, 0, tp); put(T.B, 4, tp); } },
          { name: "answer", bars: 8, i: 0.5, prog: ["Bb", "Eb", "Dm9", "Dm9", "Bb", "Eb", "A7", "A7"],
            mel: (L, m, put) => { put(seq(head(T.A, 4), 2, m.scale), 1, { inst: "piano", gain: 0.13, pan: -0.1 }); put(seq(T.A, 3, m.scale), 4, tp); } },
          { name: "peak", bars: 4, i: 0.68, prog: ["Dm9", "G7", "Bb", "A7"],
            mel: (L, m, put) => { put(T.C, 0, tp); put(T.B, 2, tp); } },
          { name: "release", bars: 8, i: 0.32, prog: ["Dm9", "Eb", "Dm9", "G7", "Dm9", "Eb", "Dm9", "Dm9"],
            mel: (L, m, put) => put(aug(T.A, 1.5), 1, Object.assign({}, tp, { dyn: 0.8 })) },
          { name: "breath", bars: 4, i: 0.15, prog: ["Dm9", "Dm9", "Eb", "Dm9"] },
        ];
      },
      comp: [[0], [0, 6], [2, 10], [0, 10], [6, 14], [0, 8, 14]],
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar, bi) {
        const m = this, sd = L.sd, d = L.e.density, st = s % 16, ten = L.tension;
        const sw = (x) => (x % 4 === 2 ? sd * m.swing : 0) + (R() - 0.5) * 0.015;
        if (st % 4 === 0) {
          const next = L.plan.bars[(bi + 1) % L.plan.len].chord[0];
          const beat = st / 4;
          let n = bar.chord[0];
          if (beat === 3) n = next + pick([-1, 1]);                       // chromatic approach, short and on the way
          else if (beat > 0) n = bar.chord[0] + pick([0, 7, 12, 7, 3, 10].filter((x) => bar.chord.map(pc12).includes(pc12(bar.chord[0] + x))));
          const p = pc12(n);
          play(L, "basspizz", m.root - 12 + p - (p > 7 ? 12 : 0), t + sw(st), { gain: 0.16 + 0.2 * ten + 0.05 * (beat === 0), pan: -0.05 });
        }
        if (st === 4 || st === 12) play(L, "taps", null, t + sw(st), { gain: (0.025 + 0.05 * ten) * d, pan: 0.35, rate: 0.95 + R() * 0.1 });
        if (st % 4 === 2 && R() < 0.2 + 0.6 * ten) play(L, "taps", null, t + sw(st), { gain: 0.025 * d, pan: 0.4, rate: 1.1 });
        if (st === 0) L.compPat = pick(m.comp.slice(0, 2 + Math.round(ten * 4)));
        if (L.compPat && L.compPat.includes(st) && !melodyIn(L, bi, "piano"))
          bar.voicing.slice(0, 4).forEach((n, i) => play(L, "piano", n, t + sw(st) + i * 0.01, { gain: 0.05 + 0.04 * ten, dur: sd * (st ? 3 : 7), r: 0.6, pan: 0.1 + i * 0.06 }));
        if (bar.b === 0 && bar.sec.i >= 0.4 && st === 0) play(L, "cymbal", null, t, { gain: 0.04 + 0.03 * ten, pan: 0.45 });
      },
    },

    mystery: {
      name: "Mystery", line: "A detail nobody else noticed. Follow it quietly.",
      colors: ["#9be37a", "#4a7fb0", "#16242a"],
      uses: layersOf(["vlnpizz", "cellopizz", "clarinet", "cellos", "violas", "glock", "taps"]),
      bpm: 76, wet: 0.55, dry: 0.8, root: 50, melRoot: 62, level: 2.78,
      scale: [0, 2, 3, 5, 7, 8, 11],
      chords: { i: [0, 3, 7], VI: [8, 12, 15], bII: [1, 5, 8], V: [7, 11, 14], iv: [5, 8, 12] },
      voices: [
        { inst: "violas", range: [57, 69], gain: 0.06, pan: 0.25, when: (sec) => sec.i >= 0.4 },
        { inst: "cellos", range: [45, 60], gain: 0.08, pan: -0.1 },
        { inst: "cellos", bass: true, range: [36, 48], gain: 0.08, pan: -0.3, when: (sec) => sec.i >= 0.3 },
      ],
      theme: {
        A: [[7, 4], [8, 4], [7, 4], [3, 4], [2, 8], [null, 8]],
        B: [[3, 4], [5, 4], [7, 4], [8, 4], [11, 8], [7, 8]],
        C: [[12, 4], [11, 4], [8, 4], [7, 4], [3, 8], [2, 8]],
      },
      get form() {
        const T = this.theme, cl = { inst: "clarinet", gain: 0.11, pan: 0.3 };
        return [
          { name: "intro", bars: 4, i: 0.2, prog: ["i", "i", "VI", "V"] },
          { name: "theme", bars: 8, i: 0.4, prog: ["i", "VI", "bII", "V", "i", "VI", "iv", "V"],
            mel: (L, m, put) => { put(T.A, 0, cl); put(T.B, 4, cl); } },
          { name: "develop", bars: 8, i: 0.5, prog: ["VI", "bII", "i", "V", "iv", "VI", "bII", "V"],
            mel: (L, m, put) => { put(seq(head(T.A, 4), 2, m.scale), 1, { inst: "vlnpizz", gain: 0.18 }); put(seq(head(T.A, 4), -1, m.scale), 5, { inst: "vlnpizz", gain: 0.18 }); } },
          { name: "peak", bars: 4, i: 0.6, prog: ["i", "VI", "bII", "V"], mel: (L, m, put) => put(T.C, 0, cl) },
          { name: "release", bars: 8, i: 0.3, prog: ["i", "iv", "i", "V", "VI", "bII", "V", "i"], mel: (L, m, put) => put(aug(T.A, 1.5), 2, cl) },
          { name: "breath", bars: 4, i: 0.15, prog: ["i", "i", "VI", "i"] },
        ];
      },
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar, bi) {
        const m = this, st = s % 16, ten = L.tension, d = L.e.density;
        if (st === 0) play(L, "cellopizz", m.root - 12 + bar.chord[0], t, { gain: 0.26, pan: -0.2 });
        // tiptoeing pizzicato on chord tones, stepping aside for the melody
        if (!melodyIn(L, bi, "vlnpizz") && s % 2 === 0 && R() < (0.25 + 0.4 * ten) * d) {
          L.walk = clamp((L.walk || 2) + pick([-1, 1, 1, -1, 2, -2]), 0, 7);
          const tones = bar.safe.concat(bar.safe.map((n) => n + 12), bar.safe.map((n) => n + 24));
          play(L, "vlnpizz", m.root + tones[L.walk % tones.length], t, { gain: 0.14, pan: rpan(0.5) });
        }
        if (s % 4 === 0) play(L, "taps", null, t, { gain: 0.025 * d, pan: -0.4, rate: 1.2 });
        if (s % 2 === 0 && R() < 0.01 * d) play(L, "glock", m.root + 24 + pc12(pick(bar.safe)), t, { gain: 0.06, pan: rpan(0.8) });
      },
    },

    spy: {
      name: "Spy", line: "Sunglasses, a borrowed name, and a car waiting downstairs.",
      colors: ["#ffb84a", "#3fa7a0", "#14202a"],
      uses: layersOf(["cellopizz", "vlnpizz", "straight", "shaker", "violas", "taps", "horn"]),
      bpm: 120, wet: 0.4, dry: 0.8, root: 52, melRoot: 64, level: 0.98,
      scale: [0, 2, 3, 5, 7, 8, 10],
      chords: { i: [0, 3, 7], iv: [5, 8, 12], VI: [8, 12, 15], V: [7, 11, 14] },
      voices: [
        { inst: "violas", range: [55, 70], gain: 0.06, pan: 0.3, when: (sec) => sec.i >= 0.35 },
        { inst: "violas", range: [60, 74], gain: 0.05, pan: -0.3, when: (sec) => sec.i >= 0.55 },
      ],
      theme: {
        A: [[0, 2], [null, 2], [3, 2], [5, 2], [7, 8], [6, 2], [5, 2], [3, 4], [0, 8]],
        B: [[7, 4], [10, 4], [12, 8], [11, 4], [10, 2], [7, 2], [5, 8]],
        C: [[12, 4], [10, 4], [7, 4], [3, 4], [0, 16]],
      },
      get form() {
        const T = this.theme, tp = { inst: "straight", gain: 0.13, pan: 0.25 };
        return [
          { name: "intro", bars: 4, i: 0.3, prog: ["i", "i", "iv", "i"] },
          { name: "theme", bars: 8, i: 0.45, prog: ["i", "i", "iv", "i", "VI", "V", "i", "i"],
            mel: (L, m, put) => { put(T.A, 0, tp); put(T.B, 2, tp); put(T.A, 4, tp); put(T.C, 6, tp); } },
          { name: "develop", bars: 8, i: 0.5, prog: ["iv", "iv", "i", "i", "VI", "V", "i", "V"],
            mel: (L, m, put) => { put(seq(head(T.A, 5), 3, m.scale), 0, { inst: "horn", gain: 0.12, oct: -12, pan: -0.3 }); put(head(T.A, 5), 4, { inst: "horn", gain: 0.12, oct: -12, pan: -0.3 }); } },
          { name: "peak", bars: 8, i: 0.7, prog: ["i", "iv", "VI", "V", "i", "iv", "V", "i"],
            mel: (L, m, put) => { put(T.C, 0, tp); put(T.A, 2, tp); put(T.B, 4, tp); put(T.C, 6, tp); } },
          { name: "release", bars: 4, i: 0.35, prog: ["i", "iv", "V", "i"] },
          { name: "breath", bars: 4, i: 0.2, prog: ["i", "i", "iv", "i"] },
        ];
      },
      line_: [0, null, 0, 3, null, 5, 7, null, 3, null, 0, null, 7, null, 5, 3],
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar) {
        const m = this, d = L.e.density, st = s % 16, ten = L.tension;
        const n = m.line_[st];
        if (n !== null && R() < 0.7 + 0.3 * d) {
          const x = bar.chord[0] + n, ok = bar.chord.map(pc12).includes(pc12(x)) || st % 4 !== 0;
          play(L, "cellopizz", m.root - 12 + (ok ? x : bar.chord[0]), t, { gain: 0.22 + 0.08 * ten, pan: -0.2 });
        }
        if ((st === 4 || st === 12) && ten > 0.35) strum(L, "vlnpizz", bar.safe.map((x) => m.root + x), t, { gain: 0.07, spread: 0.01 });
        if (s % 2 === 0) play(L, "shaker", null, t, { gain: (s % 4 === 2 ? 0.06 : 0.035) * d * (0.5 + ten), pan: 0.35 });
        if (st === 12) play(L, "taps", null, t, { gain: 0.05 * d, pan: 0.1 });
      },
    },

    western: {
      name: "Western", line: "Long straight road, dust in the light, a canyon echo.",
      colors: ["#f2a65a", "#c8553d", "#3a2414"],
      uses: layersOf(["harp", "basspizz", "taps", "oboe", "horn", "cellos"]),
      bpm: 84, wet: 0.7, dry: 0.75, root: 50, melRoot: 62, level: 1.29,
      scale: [0, 2, 4, 5, 7, 9, 11],
      chords: { I: [0, 4, 7], IV: [5, 9, 12], V: [7, 11, 14], vi: [9, 12, 16], bVII: [10, 14, 17] },
      voices: [
        { inst: "cellos", range: [50, 64], gain: 0.08, pan: 0.2, when: (sec) => sec.i >= 0.35 },
        { inst: "cellos", range: [43, 57], gain: 0.09, pan: -0.2 },
      ],
      theme: {
        A: [[0, 4], [2, 4], [4, 8], [7, 8], [4, 4], [2, 4]],
        B: [[0, 4], [9, 4], [7, 8], [4, 8], [2, 8]],
        C: [[7, 4], [9, 4], [12, 8], [9, 4], [7, 4], [4, 8], [0, 16]],
      },
      get form() {
        const T = this.theme, ob = { inst: "oboe", gain: 0.13, pan: 0.2 }, hn = { inst: "horn", gain: 0.13, oct: -12, pan: -0.3 };
        return [
          { name: "intro", bars: 4, i: 0.2, prog: ["I", "I", "IV", "I"] },
          { name: "theme", bars: 8, i: 0.4, prog: ["I", "IV", "I", "V", "I", "IV", "V", "I"],
            mel: (L, m, put) => { put(T.A, 0, ob); put(T.B, 2, ob); put(T.A, 4, ob); put(T.C, 6, ob); } },
          { name: "develop", bars: 8, i: 0.5, prog: ["I", "vi", "IV", "I", "vi", "IV", "bVII", "V"],
            mel: (L, m, put) => { put(seq(T.A, 2, m.scale), 1, hn); put(seq(T.B, -1, m.scale), 5, ob); } },
          { name: "peak", bars: 4, i: 0.62, prog: ["I", "IV", "V", "I"], mel: (L, m, put) => { put(T.A, 0, ob); put(T.A, 0, hn); put(T.B, 2, ob); } },
          { name: "release", bars: 8, i: 0.3, prog: ["IV", "I", "V", "I", "IV", "I", "V", "I"], mel: (L, m, put) => put(aug(T.A, 1.5), 1, ob) },
          { name: "breath", bars: 4, i: 0.15, prog: ["I", "I", "IV", "I"] },
        ];
      },
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar) {
        const m = this, d = L.e.density, st = s % 16, ten = L.tension;
        if (st === 0 && R() < 0.4 + 0.5 * ten) strum(L, "harp", bar.safe.concat([bar.safe[0] + 12]).map((n) => m.root + n), t, { gain: 0.12 + 0.06 * ten, spread: 0.035 });
        if (s % 8 === 0) play(L, "basspizz", m.root - 24 + bar.chord[0], t, { gain: 0.22 + 0.08 * ten, pan: -0.1 });
        if (s % 8 === 4) play(L, "basspizz", m.root - 24 + bar.chord[0] + 7, t, { gain: 0.18 + 0.06 * ten, pan: -0.1 });
        if (s % 4 === 0 || s % 4 === 3) play(L, "taps", null, t, { gain: (0.015 + 0.025 * ten) * d, rate: 0.8, pan: rpan(0.2) });
      },
    },

    epic: {
      name: "Epic", line: "The road climbs, the clouds open. This is the part they'll remember.",
      colors: ["#ffc65c", "#d9533f", "#1e2a4f"],
      uses: layersOf(["violins", "violas", "cellos", "basses", "horn", "cellospic", "timpani", "swell"]),
      bpm: 80, wet: 0.6, dry: 0.75, root: 50, melRoot: 50, level: 1.74,
      scale: [0, 2, 3, 5, 7, 8, 10],
      chords: { i: [0, 3, 7], VI: [8, 12, 15], III: [3, 7, 10], VII: [10, 14, 17], iv: [5, 8, 12], V: [7, 11, 14] },
      voices: [
        { inst: "violins", range: [67, 84], gain: 0.12, pan: 0.5, when: (sec) => sec.i >= 0.35 },
        { inst: "violins", range: [62, 79], gain: 0.12, pan: 0.3, when: (sec) => sec.i >= 0.3 },
        { inst: "violas", range: [55, 71], gain: 0.13, pan: -0.1 },
        { inst: "cellos", range: [45, 62], gain: 0.13, pan: -0.35 },
        { inst: "basses", bass: true, range: [33, 47], gain: 0.15, pan: 0.1, when: (sec) => sec.i >= 0.3 },
      ],
      theme: {
        A: [[0, 4], [7, 8], [5, 2], [3, 2], [5, 4], [3, 4], [0, 8]],
        B: [[0, 4], [7, 8], [8, 2], [10, 2], [12, 12], [null, 4]],
        C: [[12, 4], [10, 4], [8, 4], [7, 4], [5, 6], [2, 2], [0, 8]],
      },
      get form() {
        const T = this.theme, hn = { inst: "horn", gain: 0.16, pan: -0.25 };
        return [
          { name: "establish", bars: 4, i: 0.18, prog: ["i", "i", "VI", "VI"], pedal: "i" },
          { name: "theme", bars: 8, i: 0.4, prog: ["i", "VI", "III", "VII", "i", "VI", "iv", "V"],
            mel: (L, m, put) => { put(T.A, 0, hn); put(T.B, 2, hn); put(T.A, 4, hn); put(T.C, 6, hn); } },
          { name: "develop", bars: 8, i: 0.5, prog: ["VI", "VII", "i", "i", "iv", "VI", "VII", "VII"],
            mel: (L, m, put) => { put(seq(head(T.A, 4), 2, m.scale), 0, hn); put(seq(head(T.A, 4), 4, m.scale), 2, hn);
              put(seq(T.B, 2, m.scale), 4, { inst: "violins", gain: 0.1, oct: 12, pan: 0.4 }); } },
          { name: "build", bars: 4, i: 0.65, prog: ["VI", "VII", "VI", "VII"] },
          { name: "peak", bars: 8, i: 0.85, prog: ["i", "VI", "III", "VII", "i", "VI", "VII", "i"],
            mel: (L, m, put) => { const vn = { inst: "violins", gain: 0.13, oct: 12, pan: 0.4 };
              [[T.A, 0], [T.B, 2], [T.A, 4], [T.C, 6]].forEach(([mo, b]) => { put(mo, b, vn); put(mo, b, hn); }); } },
          { name: "release", bars: 8, i: 0.32, prog: ["VI", "VII", "i", "i", "VI", "iv", "i", "i"],
            mel: (L, m, put) => put(T.A, 2, Object.assign({}, hn, { dyn: 0.7 })) },
          { name: "breath", bars: 4, i: 0.12, prog: ["i", "i", "VI", "i"], pedal: "i" },
        ];
      },
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar) {
        const m = this, d = L.e.density, st = s % 16, ten = L.tension, sec = bar.sec;
        if (ten > 0.42 && s % 2 === 0 && R() < 0.5 + 0.45 * d) {
          const pat = [0, 0, 7, 0, 12, 0, 7, 0];
          play(L, "cellospic", m.root - 12 + bar.chord[0] + pat[(s / 2) % 8], t, { gain: 0.06 + 0.12 * ten, pan: -0.3 + rpan(0.1) });
        }
        if (st === 0 && bar.b === 0 && sec.i >= 0.35) play(L, "timpani", m.root - 24 + bar.chord[0], t, { gain: 0.2 + 0.15 * ten, pan: 0 });
        if (sec.name === "build" && s % 4 === 0) play(L, "timpani", m.root - 24 + bar.chord[0], t, { gain: 0.06 + 0.05 * bar.b + 0.02 * (st / 4), pan: 0 });
        if (sec.name === "peak" && (st === 0 || st === 8)) play(L, "timpani", m.root - 24 + bar.chord[0], t, { gain: st ? 0.16 : 0.24, pan: 0 });
        if (sec.name === "build" && bar.b === 2 && st === 0) play(L, "swell", null, t, { gain: 0.1, pan: rpan(0.3) });
      },
    },

    scary: {
      level: 1.19,
      name: "Scary", line: "Something in the dark just outside the frame.",
      colors: ["#5f8f74", "#2e4a63", "#14261f"],
      uses: ["cellos", "basses", "vlntrem", "gong", "swell", "harp", "bells2", "kick"],
      bpm: 60, wet: 0.9, dry: 0.55, root: 37,
      step(L, t, s) {
        const r = this.root, sd = L.sd, d = L.e.density;
        if (s % 64 === 0) {
          hold(L, "basses", r, t, 64 * sd + 2, { gain: 0.2, a: 6, r: 6, pan: -0.1, cutoff: 900 });
          hold(L, "cellos", r + 13, t + sd * 8, 56 * sd + 2, { gain: 0.11, a: 7, r: 6, pan: 0.3 });
          if (R() < 0.7) chordHold(L, "vlntrem", [r + 30, r + 31, r + 36].map((x) => x + 12), t + sd * 16, sd * 44, { gain: 0.03, a: 7, r: 6, spread: 0.9, cutoff: 3000 });
        }
        if (s % 64 === 32 && R() < 0.5) hold(L, "cellos", r + 6, t, 30 * sd, { gain: 0.08, a: 6, r: 5, pan: -0.4 });
        if (R() < 0.01 * d) play(L, "harp", r + 24 + pick([0, 1, 6, 7]), t, { gain: 0.2, pan: rpan(0.9), cutoff: 1800 });
        if (R() < 0.004 * d) play(L, "bells2", null, t, { gain: 0.08, rate: 0.5, pan: rpan(0.9) });
        if (R() < 0.003 * d) play(L, "gong", null, t, { gain: 0.15, rate: 0.7, pan: rpan(0.4) });
        if (R() < 0.003 * d) play(L, "swell", null, t, { gain: 0.1, pan: rpan(0.5), rate: 0.85 });
        if (R() < 0.004 * d) play(L, "kick", null, t, { gain: 0.25, rate: 0.6, pan: 0 });
      },
    },

    thriller: {
      name: "Thriller", line: "A train you might be followed on. Keep looking ahead.",
      colors: ["#ff4b3e", "#b0233a", "#3a0f12"],
      uses: layersOf(["cellospic", "vlnspic", "basses", "cellos", "violas", "violins", "horn", "timpani", "kick", "taps", "swell"]),
      bpm: 116, wet: 0.4, dry: 0.85, root: 45, melRoot: 45, level: 1.3,
      scale: [0, 2, 3, 5, 7, 8, 10],
      chords: { i: [0, 3, 7], VI: [8, 12, 15], bII: [1, 5, 8], iv: [5, 8, 12], V: [7, 11, 14] },
      voices: [
        { inst: "violins", range: [64, 79], gain: 0.07, pan: 0.45, when: (sec) => sec.i >= 0.6 },
        { inst: "violas", range: [55, 69], gain: 0.08, pan: 0.2, when: (sec) => sec.i >= 0.4 },
        { inst: "cellos", range: [45, 57], gain: 0.1, pan: -0.2 },
        { inst: "basses", bass: true, range: [33, 45], gain: 0.14, pan: 0 },
      ],
      theme: {
        A: [[0, 8], [1, 8], [0, 4], [7, 4], [3, 8]],
        B: [[3, 8], [5, 8], [7, 8], [8, 8]],
        C: [[12, 8], [11, 8], [8, 8], [7, 8]],
      },
      get form() {
        const T = this.theme, hn = { inst: "horn", gain: 0.15, pan: -0.25 };
        return [
          { name: "intro", bars: 4, i: 0.25, prog: ["i", "i", "i", "i"] },
          { name: "theme", bars: 8, i: 0.45, prog: ["i", "VI", "i", "bII", "i", "VI", "iv", "V"],
            mel: (L, m, put) => { put(T.A, 0, hn); put(T.B, 2, hn); put(T.A, 4, hn); put(T.C, 6, hn); } },
          { name: "develop", bars: 8, i: 0.55, prog: ["VI", "bII", "i", "i", "iv", "VI", "V", "V"],
            mel: (L, m, put) => { put(seq(T.A, 2, m.scale), 0, hn); put(T.B, 4, { inst: "violas", gain: 0.1, oct: 12, pan: 0.3 }); } },
          { name: "build", bars: 4, i: 0.7, prog: ["VI", "bII", "VI", "V"] },
          { name: "peak", bars: 8, i: 0.85, prog: ["i", "VI", "i", "bII", "i", "VI", "V", "i"],
            mel: (L, m, put) => { const vn = { inst: "violins", gain: 0.11, oct: 24, pan: 0.4 };
              [[T.A, 0], [T.C, 2], [T.A, 4], [T.C, 6]].forEach(([mo, b]) => { put(mo, b, hn); put(mo, b, vn); }); } },
          { name: "release", bars: 4, i: 0.4, prog: ["i", "VI", "V", "i"] },
          { name: "breath", bars: 4, i: 0.2, prog: ["i", "i", "i", "i"] },
        ];
      },
      ost: [0, 0, 12, 0, 0, 12, 0, 7, 0, 0, 12, 0, 0, 12, 7, 12],
      step(L, t, s) { composedStep(this, L, t, s); },
      colour(L, t, s, bar) {
        const m = this, d = L.e.density, st = s % 16, ten = L.tension, sec = bar.sec;
        if (R() < 0.7 + 0.3 * d) play(L, "cellospic", m.root - 12 + bar.chord[0] + m.ost[st], t, { gain: (st % 4 === 0 ? 0.12 : 0.08) + 0.1 * ten, pan: -0.15 });
        if (st === 14 && ten > 0.5 && R() < 0.5 * d) play(L, "vlnspic", m.root + 12 + bar.safe[2 % bar.safe.length], t, { gain: 0.09, pan: 0.35 });
        if (s % 2 === 0) play(L, "taps", null, t, { gain: (0.01 + 0.025 * ten) * d, rate: 1.4, pan: -0.3 });
        if (st === 0) play(L, "kick", null, t, { gain: 0.08 + 0.14 * ten, human: 0, pan: 0 });
        if (st === 3) play(L, "kick", null, t, { gain: 0.05 + 0.09 * ten, human: 0, pan: 0 });
        if (sec.name === "build" && s % 4 === 0) play(L, "timpani", m.root - 24 + bar.chord[0], t, { gain: 0.05 + 0.04 * bar.b, pan: 0 });
        if (bar.b === 0 && st === 0 && sec.i >= 0.45) play(L, "timpani", m.root - 24 + bar.chord[0], t, { gain: 0.22, pan: 0 });
        if (sec.name === "build" && bar.b === 2 && st === 0) play(L, "swell", null, t, { gain: 0.1, pan: rpan(0.3) });
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
