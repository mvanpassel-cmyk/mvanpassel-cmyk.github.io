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

  function makeIR(ctx, seconds, decay) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const k = 0.3 + 0.6 * (1 - t);
        lp = lp + k * ((R() * 2 - 1) - lp);
        // short pre-delay, then a smooth, darkening tail
        d[i] = i < ctx.sampleRate * 0.012 ? 0 : lp * Math.pow(1 - t, decay);
      }
    }
    return b;
  }

  /* ---------- voices ---------- */
  function voiceOut(L, pan) {
    const ctx = L.ctx;
    const g = ctx.createGain();
    g.gain.value = 0;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan || 0, -1, 1);
      g.connect(p); p.connect(L.bus);
    } else g.connect(L.bus);
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
    const n = midi == null ? b.notes[o.i == null ? Math.floor(R() * b.notes.length) : o.i] : nearest(b.notes, midi);
    const rate = midi == null ? (o.rate || 1) : Math.pow(2, (midi - n.m) / 12);
    const skip = o.skip || 0;
    const avail = (n.d - skip) / rate;
    const src = ctx.createBufferSource();
    src.buffer = b.buffer;
    src.playbackRate.value = rate;
    src.detune.value = (R() - 0.5) * (o.human == null ? 6 : o.human);
    const g = voiceOut(L, o.pan == null ? rpan(0.35) : o.pan);
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

  /* ---------- the moods ---------- */
  // root = MIDI note of the tonic; chords are semitone offsets from root.
  const MOODS = {
    dreamy: {
      level: 0.72,
      name: "Dreamy", line: "Half-awake, floating, slow light through a window.",
      colors: ["#7f9cff", "#c3a2ff", "#3b3f8f"],
      uses: ["violins", "violas", "cellos", "harp", "glock", "bells1"],
      bpm: 56, wet: 0.8, dry: 0.65, root: 62,
      chords: [[0, 4, 7, 11], [2, 6, 9, 14], [-3, 4, 7, 11], [2, 6, 9, 12]],
      step(L, t, s) {
        const m = this, sd = L.sd, per = 32, d = L.e.density;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          chordHold(L, "violins", L.ch.slice(1).map((n) => m.root + n), t, per * sd + 0.8, { gain: 0.16, a: 3, r: 4, spread: 0.6 });
          chordHold(L, "violas", [m.root + L.ch[0] - 12, m.root + L.ch[1] - 12], t, per * sd + 0.8, { gain: 0.15, a: 3, r: 4, spread: 0.3 });
          hold(L, "cellos", m.root - 24 + L.ch[0], t, per * sd + 0.8, { gain: 0.18, a: 3, r: 4, pan: 0 });
        }
        if (s % 2 === 0 && R() < 0.07 * d) play(L, "harp", m.root + 12 + pick(L.ch), t, { gain: 0.26, pan: rpan(0.7) });
        if (s % 4 === 0 && R() < 0.04 * d) play(L, "glock", m.root + 24 + pick(L.ch), t, { gain: 0.12, pan: rpan(0.8) });
        if (s % 128 === 64 && R() < 0.5) play(L, "bells1", null, t, { gain: 0.1, pan: rpan(0.6), rate: 0.9 });
      },
    },

    lovely: {
      level: 1.0,
      name: "Lovely", line: "Warm, tender, someone you are glad is next to you.",
      colors: ["#ff9fb2", "#ffcb9a", "#8a3d5c"],
      uses: ["piano", "violas", "cellos", "basses", "flute"],
      bpm: 66, wet: 0.5, dry: 0.85, root: 53,
      chords: [[0, 4, 7, 11], [-3, 4, 7, 12], [2, 5, 9, 12], [-5, 2, 7, 11]],
      scale: [0, 2, 4, 7, 9],
      start(L) { L.mel = 7; L.fluteUntil = 0; },
      step(L, t, s) {
        const m = this, sd = L.sd, per = 32, d = L.e.density;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          chordHold(L, "violas", L.ch.map((n) => m.root + n), t, per * sd + 0.4, { gain: 0.11, a: 2, r: 3, spread: 0.5 });
          hold(L, "cellos", m.root - 12 + L.ch[0], t, per * sd, { gain: 0.15, a: 1.5, r: 2.5, pan: -0.1 });
          play(L, "piano", m.root - 12 + L.ch[0], t, { gain: 0.2, pan: -0.1 });
        }
        const p = s % 4 === 0 ? 0.36 : s % 2 === 0 ? 0.12 : 0;
        if (p && R() < p * d) {
          L.mel = clamp(L.mel + pick([-2, -1, -1, 1, 1, 2, 0]), 0, 9);
          const n = m.root + 12 + 12 * Math.floor(L.mel / 5) + m.scale[L.mel % 5];
          play(L, "piano", n, t, { gain: 0.24, pan: 0.1 + rpan(0.15) });
          if (t >= L.fluteUntil && R() < 0.08) {
            play(L, "flute", n + 12, t + 2 * sd, { gain: 0.1, dur: sd * 10, a: 0.25, r: 0.8, pan: 0.35 });
            L.fluteUntil = t + sd * 24;
          }
        }
      },
    },

    happy: {
      level: 1.1,
      name: "Happy", line: "Windows down, sun on the dashboard, no hurry.",
      colors: ["#ffd36b", "#7fe0c2", "#e2793f"],
      uses: ["marimba", "cellopizz", "vlnpizz", "shaker", "tamb", "kick", "violins"],
      bpm: 100, wet: 0.28, dry: 0.85, root: 55,
      chords: [[0, 4, 7, 12], [2, 7, 11, 14], [4, 9, 12, 16], [0, 5, 9, 12]],
      arp: [0, 1, 2, 3, 2, 1, 2, 3],
      step(L, t, s) {
        const m = this, sd = L.sd, d = L.e.density, b = s % 16;
        if (b === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          if ((L.ci & 1) === 1) chordHold(L, "violins", L.ch.slice(1).map((n) => m.root + 12 + n), t, 32 * sd, { gain: 0.06, a: 1.5, r: 2, spread: 0.6 });
        }
        if (R() < (s % 4 === 0 ? 0.85 : 0.42) * d)
          play(L, "marimba", m.root + 12 + L.ch[m.arp[s % 8] % L.ch.length], t, { gain: 0.2, pan: (s % 8) / 7 - 0.5 });
        if (b === 0 || b === 6 || b === 8) play(L, "cellopizz", m.root - 12 + L.ch[0], t, { gain: 0.32, pan: -0.1 });
        if (b === 4 || b === 12) strum(L, "vlnpizz", L.ch.slice(0, 3).map((n) => m.root + n), t, { gain: 0.1, spread: 0.012 });
        if (s % 8 === 0) play(L, "kick", null, t, { gain: 0.22 * d, pan: 0, human: 0 });
        if (s % 2 === 1) play(L, "shaker", null, t, { gain: (s % 4 === 3 ? 0.07 : 0.045) * d, pan: 0.3 });
        if (b === 4 || b === 12) play(L, "tamb", null, t, { gain: 0.05 * d, pan: -0.35 });
      },
    },

    wonder: {
      level: 1.02,
      name: "Wonder", line: "Mountains turning gold. The whole world, wider than you remembered.",
      colors: ["#8fe3d4", "#ffe2a3", "#2f6f8f"],
      uses: ["harp", "violins", "violas", "cellos", "horn", "glock"],
      bpm: 72, wet: 0.7, dry: 0.7, root: 52,
      chords: [[0, 7, 12, 16, 19], [5, 12, 17, 21], [-3, 4, 9, 12, 16], [-5, 2, 7, 11, 14]],
      start(L) { L.hornUntil = 0; },
      step(L, t, s) {
        const m = this, sd = L.sd, per = 32, d = L.e.density;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          chordHold(L, "violins", L.ch.slice(-3).map((n) => m.root + 12 + n), t, per * sd + 0.5, { gain: 0.11, a: 2.5, r: 3.5, spread: 0.7 });
          chordHold(L, "violas", L.ch.slice(0, 2).map((n) => m.root + n), t, per * sd + 0.5, { gain: 0.12, a: 2.5, r: 3.5, spread: 0.4 });
          hold(L, "cellos", m.root - 12 + L.ch[0], t, per * sd, { gain: 0.16, a: 2, r: 3, pan: 0 });
          if (t >= L.hornUntil && R() < 0.5) { hold(L, "horn", m.root - 12 + L.ch[1], t + sd * 4, sd * 20, { gain: 0.12, a: 2, r: 2.5, pan: -0.3 }); L.hornUntil = t + sd * 64; }
        }
        const b = s % 16;
        if (b < 10 && R() < 0.6 * d) {
          const tones = L.ch.concat(L.ch.map((n) => n + 12));
          play(L, "harp", m.root + 12 + tones[b % tones.length], t, { gain: 0.2, pan: b / 9 - 0.5 });
        }
        if (s % 4 === 0 && R() < 0.03 * d) play(L, "glock", m.root + 36 + pick(L.ch) % 12, t, { gain: 0.1, pan: rpan(0.8) });
      },
    },

    fairytale: {
      level: 1.46,
      name: "Fairy tale", line: "Once upon a time, a little lantern in a big dark forest.",
      colors: ["#f5b8ff", "#a9d8ff", "#4b3a8f"],
      uses: ["basspizz", "vlnpizz", "glock", "flute", "violas", "triangle"],
      bpm: 126, wet: 0.5, dry: 0.8, root: 60,
      chords: [[0, 4, 7], [-3, 0, 4], [5, 9, 12], [-5, -1, 2]],
      scale: [0, 2, 4, 5, 7, 9, 11],
      start(L) { L.mel = 7; L.fluteUntil = 0; },
      step(L, t, s) {
        const m = this, sd = L.sd, per = 24, d = L.e.density, b = s % 12;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          chordHold(L, "violas", L.ch.map((n) => m.root - 12 + n), t, per * sd, { gain: 0.07, a: 1, r: 1.5, spread: 0.5 });
          if (L.ci % 4 === 1 && R() < 0.6) play(L, "triangle", null, t, { gain: 0.06, pan: 0.5 });
        }
        if (b === 0) play(L, "basspizz", m.root - 24 + L.ch[0], t, { gain: 0.32, pan: -0.1 });
        if (b === 4 || b === 8) strum(L, "vlnpizz", L.ch.map((n) => m.root + n), t, { gain: 0.08, spread: 0.01 });
        if (s % 2 === 0 && R() < (b === 0 ? 0.6 : 0.3) * d) {
          L.mel = clamp(L.mel + pick([-2, -1, -1, 1, 1, 2]), 0, 13);
          const n = m.root + 12 + 12 * Math.floor(L.mel / 7) + m.scale[L.mel % 7];
          if (t < L.fluteUntil) return;
          if (R() < 0.12) { play(L, "flute", n, t, { gain: 0.12, dur: sd * 5, a: 0.06, r: 0.4, pan: 0.25 }); L.fluteUntil = t + sd * 6; }
          else play(L, "glock", n + 12, t, { gain: 0.11, pan: rpan(0.5) });
        }
      },
    },

    melancholy: {
      level: 1.29,
      name: "Melancholy", line: "Rain on the window. The last day of the trip.",
      colors: ["#8aa0b8", "#5d6f8a", "#1d2738"],
      uses: ["piano", "cellos", "violas", "clarinet"],
      bpm: 60, wet: 0.75, dry: 0.75, root: 57,
      chords: [[0, 3, 7, 10], [-4, 0, 3, 7], [5, 8, 12], [-5, -2, 2, 7]],
      scale: [0, 3, 5, 7, 10],
      start(L) { L.mel = 5; L.rest = false; L.clarUntil = 0; },
      step(L, t, s) {
        const m = this, sd = L.sd, per = 32, d = L.e.density, b = s % 16;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          hold(L, "cellos", m.root - 24 + L.ch[0], t, per * sd, { gain: 0.14, a: 2.5, r: 3.5, pan: -0.15 });
          chordHold(L, "violas", L.ch.slice(1, 3).map((n) => m.root - 12 + n), t, per * sd, { gain: 0.07, a: 3, r: 3.5, spread: 0.4 });
          play(L, "piano", m.root - 24 + L.ch[0], t, { gain: 0.22, pan: -0.15 });
          if (t >= L.clarUntil && R() < 0.3) { play(L, "clarinet", m.root + pick(L.ch), t + sd * 8, { gain: 0.1, dur: sd * 14, a: 0.6, r: 1.5, pan: 0.3 }); L.clarUntil = t + sd * 64; }
        }
        if (b === 0) L.rest = R() < 0.3;
        if ((b === 4 || b === 8) && s % per < 16) play(L, "piano", m.root - 12 + pick(L.ch), t, { gain: 0.12, pan: rpan(0.3) });
        if (!L.rest && s % 4 === 0 && R() < 0.25 * d) {
          L.mel = clamp(L.mel + pick([-2, -1, -1, 1, 0, 1]), 0, 9);
          play(L, "piano", m.root + 12 * Math.floor(L.mel / 5) + m.scale[L.mel % 5], t, { gain: 0.22, pan: 0.05 + rpan(0.2) });
        }
      },
    },

    scifi: {
      level: 1.55,
      name: "Sci-fi", line: "A quiet station orbiting somewhere far. Lights blinking in sequence.",
      colors: ["#5ad1ff", "#7a6bff", "#0e2a4a"],
      uses: ["organ", "piano", "vlntrem", "glock", "bells2"],
      bpm: 84, wet: 0.7, dry: 0.7, root: 57,
      chords: [[0, 7, 12, 15], [-4, 3, 8, 15], [-2, 5, 10, 14], [-7, 0, 5, 12]],
      arp: [0, 1, 2, 1, 3, 1, 2, 1],
      step(L, t, s) {
        const m = this, sd = L.sd, per = 64, d = L.e.density;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          chordHold(L, "organ", L.ch.map((n) => m.root - 12 + n), t, per * sd + 1, { gain: 0.1, a: 4, r: 5, spread: 0.7 });
          hold(L, "organ", m.root - 24 + L.ch[0], t, per * sd + 1, { gain: 0.12, a: 4, r: 5, pan: 0 });
          if (R() < 0.6) chordHold(L, "vlntrem", [m.root + 12 + L.ch[2], m.root + 24 + L.ch[1]], t + sd * 16, sd * 40, { gain: 0.04, a: 4, r: 4, spread: 0.8 });
        }
        // the ticking piano: steady 8ths, like a clock in orbit
        if (s % 2 === 0 && R() < 0.55 + 0.4 * d)
          play(L, "piano", m.root + 12 + L.ch[m.arp[(s / 2) % 8] % L.ch.length], t, { gain: 0.11 + (s % 8 === 0 ? 0.05 : 0), dur: sd * 3, r: 0.8, pan: (s % 4 ? 0.3 : -0.3) });
        if (R() < 0.01 * d) {
          const f = m.root + 36 + pick([0, 7, 12, 15]);
          for (let i = 0; i < 1 + Math.floor(R() * 3); i++) play(L, "glock", f, t + i * 0.13, { gain: 0.05, dur: 0.15, r: 0.2, pan: rpan(0.9) });
        }
        if (s % 256 === 128 && R() < 0.6) play(L, "bells2", null, t, { gain: 0.07, rate: 0.75, pan: rpan(0.6) });
      },
    },

    neon: {
      level: 0.92,
      name: "Neon night", line: "City lights sliding past a taxi window at 2 a.m.",
      colors: ["#ff4fd8", "#41e6ff", "#2a0a4a"],
      uses: ["piano", "basspizz", "kick", "snare", "shaker", "violins", "straight"],
      bpm: 96, wet: 0.45, dry: 0.75, root: 52,
      chords: [[0, 3, 7, 12], [-4, 0, 3, 8], [3, 7, 10, 15], [-2, 2, 5, 10]],
      scale: [0, 3, 5, 7, 10],
      start(L) { L.leadUntil = 0; },
      step(L, t, s) {
        const m = this, sd = L.sd, d = L.e.density, b = s % 16;
        if (b === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          chordHold(L, "violins", L.ch.slice(1).map((n) => m.root + 12 + n), t, 16 * sd, { gain: 0.06, a: 0.8, r: 1.2, spread: 0.7 });
        }
        if (s % 2 === 0) play(L, "basspizz", m.root - 24 + L.ch[0] + (s % 4 === 2 ? 12 : 0), t, { gain: 0.28, dur: sd * 1.8, r: 0.15, pan: 0 });
        if (s % 4 === 2 && R() < 0.85) L.ch.slice(0, 3).forEach((n, i) => play(L, "piano", m.root + n, t, { gain: 0.08, dur: sd * 1.4, r: 0.12, pan: i * 0.2 - 0.2 }));
        if (s % 4 === 0) play(L, "kick", null, t, { gain: 0.25 * d, human: 0, pan: 0 });
        if (b === 4 || b === 12) play(L, "snare", null, t, { gain: 0.12 * d, pan: 0.05 });
        play(L, "shaker", null, t, { gain: (s % 2 ? 0.05 : 0.03) * d, pan: 0.3 });
        if (s % 4 === 0 && t >= L.leadUntil && R() < 0.1 * d) {
          const dur = sd * pick([4, 6, 8]);
          play(L, "straight", m.root + 12 + pick(m.scale), t, { gain: 0.1, dur, a: 0.05, r: 0.5, pan: 0.2 });
          L.leadUntil = t + dur + sd * 6;
        }
      },
    },

    noir: {
      level: 1.2,
      name: "Noir", line: "Paris, 3 a.m. Wet cobblestones and a muted trumpet somewhere.",
      colors: ["#c9b38a", "#7d6a52", "#1a1714"],
      uses: ["harmon", "basspizz", "taps", "piano", "cymbal", "cellos"],
      bpm: 66, wet: 0.55, dry: 0.85, root: 50,
      chords: [[0, 3, 7, 10, 14], [5, 8, 12, 15], [1, 5, 8, 12], [-5, -1, 2, 5]],
      blues: [0, 3, 5, 7, 10, 12, 15],
      start(L) { L.phrase = []; L.leadUntil = 0; L.walk = 0; },
      step(L, t, s) {
        const m = this, sd = L.sd, per = 32, d = L.e.density, b = s % 16;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          hold(L, "cellos", m.root - 12 + L.ch[0], t, per * sd, { gain: 0.08, a: 2, r: 3, pan: -0.2 });
          if (L.ci % 4 === 1) play(L, "cymbal", null, t, { gain: 0.05, pan: 0.4 });
        }
        // piano comping: soft voicings, a little late, like a tired pianist in the corner
        if (s % per === 0 || (s % per === 22 && R() < 0.55))
          L.ch.slice(1).forEach((n, i) => play(L, "piano", m.root + n, t + 0.02 + i * 0.012, { gain: 0.07, dur: sd * 10, r: 1, pan: 0.15 + i * 0.05 }));
        // walking bass on the beat
        if (s % 4 === 0) {
          const target = m.chords[L.ci % m.chords.length][0];
          let n = L.ch[0];
          const beat = (s % per) / 4;
          if (beat === 7) n = target + pick([-1, 1]);               // approach note into the next chord
          else if (beat > 0) n = L.ch[0] + pick([3, 5, 7, 10, 7, 12]);
          play(L, "basspizz", m.root - 24 + n, t, { gain: 0.3, pan: -0.05 });
          play(L, "taps", null, t, { gain: 0.05 * d, pan: 0.35, rate: 0.95 + R() * 0.1 });
        }
        if (s % 4 === 3 && R() < 0.7) play(L, "taps", null, t, { gain: 0.03 * d, pan: 0.4, rate: 1.05 });
        // Harmon-muted trumpet: short phrases, lots of air between them
        if (t >= L.leadUntil && s % 2 === 0) {
          if (!L.phrase.length && R() < 0.09 * d) {
            let k = 2 + Math.floor(R() * 4), at = 0, idx = 2 + Math.floor(R() * 3);
            L.phrase = [];
            while (k--) {
              const len = pick([2, 2, 4, 4, 6, 8]);
              idx = clamp(idx + pick([-2, -1, -1, 1, 1, 2]), 0, m.blues.length - 1);
              L.phrase.push([at, len, m.blues[idx]]); at += len + pick([0, 0, 2]);
            }
            L.phraseStart = s;
          }
          if (L.phrase.length) {
            const [at, len, n] = L.phrase[0];
            if (s - L.phraseStart >= at) {
              L.phrase.shift();
              play(L, "harmon", m.root + 12 + n, t, { gain: 0.22, dur: len * sd * 0.95, a: 0.03, r: 0.3, pan: 0.18, human: 10 });
              if (!L.phrase.length) L.leadUntil = t + sd * (12 + Math.floor(R() * 20));
            }
          }
        }
      },
    },

    mystery: {
      level: 1.55,
      name: "Mystery", line: "A detail nobody else noticed. Follow it quietly.",
      colors: ["#9be37a", "#4a7fb0", "#16242a"],
      uses: ["vlnpizz", "cellopizz", "clarinet", "cellos", "glock", "taps"],
      bpm: 76, wet: 0.55, dry: 0.8, root: 62,
      chords: [[0, 3, 6, 9], [0, 3, 6, 10], [-1, 2, 5, 8], [0, 3, 6, 10]],
      oct: [0, 1, 3, 4, 6, 7, 9, 10],
      start(L) { L.mel = 8; L.clarUntil = 0; },
      step(L, t, s) {
        const m = this, sd = L.sd, per = 64, d = L.e.density;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          chordHold(L, "cellos", [m.root - 24 + L.ch[0], m.root - 12 + L.ch[1]], t, per * sd, { gain: 0.09, a: 3, r: 3, spread: 0.4 });
        }
        if (s % 16 === 0) play(L, "cellopizz", m.root - 24 + L.ch[0], t, { gain: 0.3, pan: -0.2 });
        if (s % 2 === 0 && R() < 0.6 * d) {
          L.mel = clamp(L.mel + pick([-1, -1, 1, 1, 2, -2, 0]), 0, 15);
          play(L, "vlnpizz", m.root - 12 + 12 * Math.floor(L.mel / 8) + m.oct[L.mel % 8], t, { gain: 0.2, pan: rpan(0.5) });
        }
        if (s % 4 === 0) play(L, "taps", null, t, { gain: 0.03 * d, pan: -0.4, rate: 1.2 });
        if (t >= L.clarUntil && s % 16 === 8 && R() < 0.25) {
          play(L, "clarinet", m.root - 12 + pick(L.ch), t, { gain: 0.1, dur: sd * 12, a: 0.5, r: 1, pan: 0.3 });
          L.clarUntil = t + sd * 48;
        }
        if (s % 2 === 0 && R() < 0.015 * d) play(L, "glock", m.root + 24 + pick(m.oct), t, { gain: 0.08, pan: rpan(0.8) });
      },
    },

    spy: {
      level: 0.83,
      name: "Spy", line: "Sunglasses, a borrowed name, and a car waiting downstairs.",
      colors: ["#ffb84a", "#3fa7a0", "#14202a"],
      uses: ["cellopizz", "vlnpizz", "straight", "shaker", "violas", "taps"],
      bpm: 120, wet: 0.4, dry: 0.8, root: 52,
      chords: [[0, 3, 7, 11], [0, 3, 7, 11], [5, 8, 12, 16], [-5, -1, 2, 6]],
      line_: [0, null, 0, 3, null, 5, 4, null, 3, null, 0, null, 7, null, 6, 5],
      start(L) { L.leadUntil = 0; },
      step(L, t, s) {
        const m = this, sd = L.sd, per = 32, d = L.e.density, b = s % 16;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          chordHold(L, "violas", L.ch.map((n) => m.root + n), t, per * sd, { gain: 0.07, a: 1, r: 1.5, spread: 0.6 });
        }
        const n = m.line_[b];
        if (n !== null && R() < 0.78 + 0.22 * d) play(L, "cellopizz", m.root - 12 + L.ch[0] + n, t, { gain: 0.3, pan: -0.2 });
        if (b === 4 || b === 12) strum(L, "vlnpizz", L.ch.map((x) => m.root + x), t, { gain: 0.08, spread: 0.01 });
        if (s % 2 === 0) play(L, "shaker", null, t, { gain: (s % 4 === 2 ? 0.07 : 0.04) * d, pan: 0.35 });
        if (b === 12) play(L, "taps", null, t, { gain: 0.06 * d, pan: 0.1 });
        if (b === 0 && t >= L.leadUntil && R() < 0.3 * d) {
          play(L, "straight", m.root + 12 + L.ch[3], t, { gain: 0.14, dur: sd * 6, a: 0.02, r: 0.5, pan: 0.25 });
          play(L, "straight", m.root + 12 + L.ch[2], t + sd * 7, { gain: 0.1, dur: sd * 3, a: 0.02, r: 0.4, pan: 0.25 });
          L.leadUntil = t + sd * 32;
        }
      },
    },

    western: {
      level: 1.07,
      name: "Western", line: "Long straight road, dust in the light, a canyon echo.",
      colors: ["#f2a65a", "#c8553d", "#3a2414"],
      uses: ["harp", "basspizz", "taps", "oboe", "horn", "cellos"],
      bpm: 84, wet: 0.7, dry: 0.75, root: 50,
      chords: [[0, 7, 12], [5, 12, 17], [0, 7, 12], [-5, 2, 7]],
      penta: [0, 2, 4, 7, 9],
      start(L) { L.leadUntil = 0; L.mel = 5; },
      step(L, t, s) {
        const m = this, sd = L.sd, per = 32, d = L.e.density;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          chordHold(L, "cellos", [m.root - 12 + L.ch[0], m.root - 12 + L.ch[1]], t, per * sd, { gain: 0.1, a: 2.5, r: 3, spread: 0.4 });
          if (R() < 0.8) strum(L, "harp", L.ch.concat([L.ch[0] + 16]).map((n) => m.root + n), t, { gain: 0.16, spread: 0.035 });
          if (L.ci % 4 === 3) hold(L, "horn", m.root - 12 + L.ch[1], t, per * sd, { gain: 0.1, a: 3, r: 3, pan: -0.35 });
        }
        if (s % 8 === 0) play(L, "basspizz", m.root - 24 + L.ch[0], t, { gain: 0.3, pan: -0.1 });
        if (s % 8 === 4) play(L, "basspizz", m.root - 24 + L.ch[0] + 7, t, { gain: 0.24, pan: -0.1 });
        if (s % 4 === 0 || s % 4 === 3) play(L, "taps", null, t, { gain: 0.03 * d, rate: 0.8, pan: rpan(0.2) });
        if (s % 4 === 0 && t >= L.leadUntil && R() < 0.15 * d) {
          L.mel = clamp(L.mel + pick([-2, -1, 1, 2, 3, -3]), 0, 9);
          const dur = sd * pick([6, 8, 12]);
          play(L, "oboe", m.root + 12 * Math.floor(L.mel / 5) + m.penta[L.mel % 5] + 12, t, { gain: 0.13, dur, a: 0.08, r: 0.8, pan: 0.2 });
          L.leadUntil = t + dur + sd * 4;
        }
      },
    },

    epic: {
      level: 0.77,
      name: "Epic", line: "The road climbs, the clouds open. This is the part they'll remember.",
      colors: ["#ffc65c", "#d9533f", "#1e2a4f"],
      uses: ["violins", "violas", "cellos", "basses", "cellospic", "timpani", "horn", "swell"],
      bpm: 80, wet: 0.6, dry: 0.75, root: 50,
      chords: [[0, 7, 12, 15], [-4, 3, 8, 12], [3, 10, 15, 19], [-2, 5, 10, 14]],
      start(L) { L.hornUntil = 0; },
      step(L, t, s) {
        const m = this, sd = L.sd, per = 32, d = L.e.density, b = s % 16;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          chordHold(L, "violins", L.ch.slice(1).map((n) => m.root + 12 + n), t, per * sd, { gain: 0.14, a: 1.5, r: 2.5, spread: 0.8 });
          chordHold(L, "violas", L.ch.slice(0, 3).map((n) => m.root + n), t, per * sd, { gain: 0.13, a: 1.5, r: 2.5, spread: 0.5 });
          hold(L, "cellos", m.root - 12 + L.ch[0], t, per * sd, { gain: 0.16, a: 1.2, r: 2, pan: -0.2 });
          hold(L, "basses", m.root - 24 + L.ch[0], t, per * sd, { gain: 0.16, a: 1.2, r: 2, pan: 0.1 });
          if (t >= L.hornUntil && R() < 0.55 * d) {
            const n = m.root + pick(L.ch.slice(1));
            hold(L, "horn", n - 12, t + sd * 2, sd * 14, { gain: 0.15, a: 0.8, r: 1.5, pan: -0.25 });
            L.hornUntil = t + sd * 32;
          }
        }
        if (s % 2 === 0 && R() < 0.55 + 0.4 * d) play(L, "cellospic", m.root - 12 + L.ch[(s / 2) % L.ch.length], t, { gain: 0.16, pan: rpan(0.4) });
        if (b === 0) play(L, "timpani", m.root - 24 + L.ch[0], t, { gain: 0.32, pan: 0 });
        if (b === 10) play(L, "timpani", m.root - 24 + L.ch[0], t, { gain: 0.2, pan: 0 });
        if (s % 128 >= 120 && s % 2 === 0) play(L, "timpani", m.root - 24, t, { gain: 0.1 + 0.03 * (s % 128 - 120), pan: 0 });
        if (s % 128 === 104) play(L, "swell", null, t, { gain: 0.12, pan: rpan(0.3) });
      },
    },

    scary: {
      level: 0.91,
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
      level: 1.08,
      name: "Thriller", line: "A train you might be followed on. Keep looking ahead.",
      colors: ["#ff4b3e", "#b0233a", "#3a0f12"],
      uses: ["cellospic", "vlnspic", "basses", "vlntrem", "timpani", "kick", "taps", "swell"],
      bpm: 116, wet: 0.4, dry: 0.85, root: 45,
      chords: [[0, 7, 12, 15], [-4, 3, 8, 12], [0, 7, 12, 15], [1, 5, 8, 13]],
      ost: [0, 0, 12, 0, 0, 12, 0, 7, 0, 0, 12, 0, 0, 12, 3, 7],
      step(L, t, s) {
        const m = this, sd = L.sd, d = L.e.density, per = 32;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          hold(L, "basses", m.root - 12 + L.ch[0], t, per * sd, { gain: 0.16, a: 1.5, r: 1.5, pan: 0 });
          if (L.ci % 2 === 0) chordHold(L, "vlntrem", L.ch.slice(1).map((n) => m.root + 12 + n), t, per * sd, { gain: 0.035, a: 2.5, r: 2, spread: 0.7 });
        }
        if (R() < 0.75 + 0.25 * d) play(L, "cellospic", m.root - 12 + L.ch[0] + m.ost[s % 16], t, { gain: s % 4 === 0 ? 0.2 : 0.14, pan: -0.15 });
        if (s % 16 === 14 && R() < 0.5 * d) play(L, "vlnspic", m.root + 12 + L.ch[2], t, { gain: 0.1, pan: 0.35 });
        if (s % 2 === 0) play(L, "taps", null, t, { gain: 0.025 * d, rate: 1.4, pan: -0.3 });
        if (s % 16 === 0) play(L, "kick", null, t, { gain: 0.2, human: 0, pan: 0 });
        if (s % 16 === 3) play(L, "kick", null, t, { gain: 0.13, human: 0, pan: 0 });
        if (s % 64 === 0) play(L, "timpani", m.root - 24 + L.ch[0], t, { gain: 0.2, pan: 0 });
        if (s % 128 === 104) play(L, "swell", null, t, { gain: 0.1, pan: rpan(0.3) });
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
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = makeIR(ctx, 4.8, 2.8);
      this.dry = ctx.createGain();
      this.dry.connect(hp); this.reverb.connect(hp);
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

  const api = { Engine, Bank, MOODS, ORDER, renderLoop, encodeWAV };
  root.TripEngine = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
