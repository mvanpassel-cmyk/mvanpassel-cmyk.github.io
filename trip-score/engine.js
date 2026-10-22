/* Trip Score — generative film-score engine.
   Works with a live AudioContext or an OfflineAudioContext.
   Each mood is a small "composer" that is called on every 16th note. */
(function (root) {
  "use strict";

  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const R = Math.random;
  const pick = (a) => a[Math.floor(R() * a.length)];
  const rpan = (w = 0.7) => (R() * 2 - 1) * w;

  /* ---------- shared buffers ---------- */
  function makeNoise(ctx, seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = R() * 2 - 1;
    return b;
  }
  // Long, dark, diffuse hall: decaying stereo noise, gently low-passed.
  function makeIR(ctx, seconds, decay) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const k = 0.35 + 0.6 * (1 - t); // darker as it decays
        lp = lp + k * ((R() * 2 - 1) - lp);
        d[i] = lp * Math.pow(1 - t, decay);
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
      p.pan.value = Math.max(-1, Math.min(1, pan || 0));
      g.connect(p); p.connect(L.bus);
    } else g.connect(L.bus);
    return g;
  }

  // Sustained chord pad: two detuned oscillators per note through a low-pass.
  function pad(L, freqs, t, dur, o) {
    const ctx = L.ctx;
    const a = o.a || 2, r = o.r || 3, peak = (o.gain || 0.05) / Math.sqrt(freqs.length);
    freqs.forEach((f, i) => {
      const g = voiceOut(L, o.spread ? ((i / Math.max(1, freqs.length - 1)) * 2 - 1) * o.spread : 0);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = o.cutoff || 1500; lp.Q.value = 0.4;
      lp.connect(g);
      [-1, 1].forEach((s, k) => {
        const osc = ctx.createOscillator();
        osc.type = k === 0 ? (o.type || "triangle") : (o.type2 || o.type || "sine");
        osc.frequency.value = f;
        osc.detune.value = s * (o.detune || 6) + (R() - 0.5) * 3;
        osc.connect(lp);
        osc.start(t); osc.stop(t + dur + r + 0.1);
      });
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + a);
      g.gain.setValueAtTime(peak, t + Math.max(a, dur));
      g.gain.linearRampToValueAtTime(0, t + Math.max(a, dur) + r);
    });
  }

  // Soft piano-ish pluck.
  function pluck(L, f, t, o) {
    const ctx = L.ctx;
    const g = voiceOut(L, o.pan);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = o.bright || 2500; lp.connect(g);
    const decay = o.decay || 1.5, peak = o.gain || 0.05;
    const o1 = ctx.createOscillator(); o1.type = o.type || "sine"; o1.frequency.value = f;
    const o2 = ctx.createOscillator(); o2.type = "triangle"; o2.frequency.value = f * 2;
    const g2 = ctx.createGain(); g2.gain.value = 0.22;
    o1.connect(lp); o2.connect(g2); g2.connect(lp);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    [o1, o2].forEach((x) => { x.start(t); x.stop(t + decay + 0.05); });
  }

  // FM bell / glass.
  function bell(L, f, t, o) {
    const ctx = L.ctx;
    const g = voiceOut(L, o.pan);
    const decay = o.decay || 3, peak = o.gain || 0.03;
    const car = ctx.createOscillator(); car.frequency.value = f;
    const mod = ctx.createOscillator(); mod.frequency.value = f * (o.ratio || 3.5);
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(f * (o.index || 1.5), t);
    mg.gain.exponentialRampToValueAtTime(f * 0.01 + 0.01, t + decay * 0.6);
    mod.connect(mg); mg.connect(car.frequency); car.connect(g);
    if (o.bend) car.detune.setValueAtTime(0, t), car.detune.linearRampToValueAtTime(o.bend, t + decay);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + (o.attack || 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    [car, mod].forEach((x) => { x.start(t); x.stop(t + decay + 0.05); });
  }

  // Filtered saw bass / ostinato.
  function bass(L, f, t, dur, o) {
    const ctx = L.ctx;
    const g = voiceOut(L, o.pan || 0);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.Q.value = o.q || 2;
    const c = o.cutoff || 500;
    lp.frequency.setValueAtTime(c * 3, t);
    lp.frequency.exponentialRampToValueAtTime(c, t + Math.min(0.25, dur));
    lp.connect(g);
    const osc = ctx.createOscillator(); osc.type = o.type || "sawtooth"; osc.frequency.value = f;
    osc.connect(lp);
    const peak = o.gain || 0.06;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.008);
    g.gain.setTargetAtTime(0, t + dur * 0.6, dur * 0.25 + 0.01);
    osc.start(t); osc.stop(t + dur * 2 + 0.2);
  }

  // Soft kick / heartbeat / distant boom.
  function thump(L, t, o) {
    const ctx = L.ctx;
    const g = voiceOut(L, 0);
    const osc = ctx.createOscillator(); osc.type = "sine";
    const f0 = o.f0 || 110, f1 = o.f1 || 42, len = o.len || 0.35;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + len * 0.4);
    osc.connect(g);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(o.gain || 0.1, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    osc.start(t); osc.stop(t + len + 0.05);
  }

  // Short noise tick (clock, shaker).
  function tick(L, t, o) {
    const ctx = L.ctx;
    const g = voiceOut(L, o.pan || 0);
    const src = ctx.createBufferSource(); src.buffer = L.e.noise;
    const hp = ctx.createBiquadFilter(); hp.type = o.band ? "bandpass" : "highpass";
    hp.frequency.value = o.freq || 7000; hp.Q.value = o.band ? 8 : 0.7;
    src.connect(hp); hp.connect(g);
    const len = o.len || 0.04;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(o.gain || 0.02, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    src.start(t, R() * 1.5); src.stop(t + len + 0.02);
  }

  // Rising noise swell ("reverse cymbal") that cuts off.
  function swell(L, t, dur, o) {
    const ctx = L.ctx;
    const g = voiceOut(L, rpan(0.4));
    const src = ctx.createBufferSource(); src.buffer = L.e.noise; src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 3;
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.exponentialRampToValueAtTime(o.top || 4000, t + dur);
    src.connect(lp); lp.connect(g);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(o.gain || 0.04, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.08);
    src.start(t); src.stop(t + dur + 0.15);
  }

  // Continuous elements, stopped when the layer stops.
  function drone(L, freqs, o) {
    const ctx = L.ctx, t = L.t0;
    const g = voiceOut(L, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(o.gain || 0.04, t + (o.a || 6));
    const lfo = ctx.createOscillator(); lfo.frequency.value = o.lfoRate || 0.05;
    const lg = ctx.createGain(); lg.gain.value = o.lfoDepth || 10; lfo.connect(lg);
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = o.cutoff || 800; lp.connect(g);
    const nodes = [lfo];
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator(); osc.type = o.type || "sine"; osc.frequency.value = f;
      osc.detune.value = (i % 2 ? 1 : -1) * 4;
      lg.connect(osc.detune);
      osc.connect(lp); nodes.push(osc);
    });
    nodes.forEach((n) => n.start(t));
    L.continuous.push(nodes);
  }

  function noiseBed(L, o) {
    const ctx = L.ctx, t = L.t0;
    const g = voiceOut(L, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(o.gain || 0.03, t + (o.a || 8));
    const src = ctx.createBufferSource(); src.buffer = L.e.noise; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass";
    bp.frequency.value = o.center || 500; bp.Q.value = o.q || 5;
    const lfo = ctx.createOscillator(); lfo.frequency.value = o.lfoRate || 0.07;
    const lg = ctx.createGain(); lg.gain.value = o.lfoDepth || 300;
    lfo.connect(lg); lg.connect(bp.frequency);
    src.connect(bp); bp.connect(g);
    src.start(t); lfo.start(t);
    L.continuous.push([src, lfo]);
  }

  // Sustained melodic lead with delayed vibrato (whistle, muted trumpet, horn).
  function lead(L, f, t, dur, o) {
    const ctx = L.ctx;
    const g = voiceOut(L, o.pan || 0);
    const lp = ctx.createBiquadFilter();
    lp.type = o.band ? "bandpass" : "lowpass"; lp.frequency.value = o.cutoff || 1500; lp.Q.value = o.q || 1;
    lp.connect(g);
    const osc = ctx.createOscillator(); osc.type = o.type || "sine"; osc.frequency.value = f;
    const lfo = ctx.createOscillator(); lfo.frequency.value = o.vib || 5;
    const vg = ctx.createGain();
    vg.gain.setValueAtTime(0, t);
    vg.gain.linearRampToValueAtTime(o.vibDepth || 12, t + Math.min(0.5, dur));
    lfo.connect(vg); vg.connect(osc.detune);
    if (o.scoop) { osc.detune.setValueAtTime(-o.scoop, t); osc.detune.linearRampToValueAtTime(0, t + 0.09); }
    osc.connect(lp);
    const a = o.a || 0.08, r = o.r || 0.4, peak = o.gain || 0.04;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.setValueAtTime(peak * 0.85, t + Math.max(a, dur));
    g.gain.linearRampToValueAtTime(0, t + Math.max(a, dur) + r);
    [osc, lfo].forEach((x) => { x.start(t); x.stop(t + dur + r + 0.1); });
  }

  // Strummed chord: plucks staggered by a few milliseconds.
  function strum(L, freqs, t, o) {
    freqs.forEach((f, i) => pluck(L, f, t + i * (o.spread || 0.022), Object.assign({}, o, { pan: (i / freqs.length - 0.5) * 0.6 })));
  }

  /* ---------- the moods ---------- */
  const MOODS = {
    dreamy: {
      name: "Dreamy", line: "Half-awake, floating, slow light through a window.",
      colors: ["#7f9cff", "#c3a2ff", "#3b3f8f"],
      bpm: 56, wet: 0.85, dry: 0.7, root: 50,
      chords: [[0, 7, 11, 14, 19], [2, 9, 14, 18, 21], [-3, 4, 7, 11, 16], [2, 6, 9, 14, 18]],
      step(L, t, s) {
        const m = this, sd = L.sd, per = 32;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          pad(L, L.ch.map((n) => mtof(m.root + n)), t, per * sd + 1, { type: "triangle", type2: "sine", a: 3.5, r: 5, gain: 0.07, cutoff: 1300, detune: 8, spread: 0.6 });
          pad(L, [mtof(m.root - 12 + L.ch[0])], t, per * sd + 1, { type: "sine", a: 3, r: 4, gain: 0.05, cutoff: 500 });
        }
        if (s % 2 === 0 && R() < 0.1 * L.e.density) {
          bell(L, mtof(m.root + 24 + pick(L.ch)), t, { gain: 0.03, decay: 4.5, ratio: 3.5, index: 1.1, pan: rpan(0.8) });
        }
      },
    },

    scary: {
      name: "Scary", line: "Something in the dark just outside the frame.",
      colors: ["#5f8f74", "#2e4a63", "#14261f"],
      bpm: 60, wet: 0.9, dry: 0.6, root: 37,
      start(L) {
        const r = this.root;
        drone(L, [mtof(r), mtof(r + 13), mtof(r + 6)], { gain: 0.06, lfoRate: 0.045, lfoDepth: 14, cutoff: 700, type: "triangle" });
        noiseBed(L, { gain: 0.05, center: 450, q: 7, lfoRate: 0.06, lfoDepth: 320 });
      },
      step(L, t, s) {
        const r = this.root, d = L.e.density;
        if (s % 64 === 0) pad(L, [0, 1, 6, 7].map((n) => mtof(r + 24 + n)), t, 64 * L.sd, { type: "sine", a: 7, r: 7, gain: 0.03, cutoff: 900, detune: 14, spread: 0.8 });
        if (R() < 0.012 * d) bell(L, mtof(r + 36 + pick([0, 1, 6, 11, 13])), t, { gain: 0.022, decay: 6, ratio: 1.41, index: 2.4, pan: rpan(0.9), bend: -40, attack: 0.4 });
        if (R() < 0.004 * d) thump(L, t, { f0: 60, f1: 28, len: 3, gain: 0.16 });
        if (R() < 0.003 * d) swell(L, t, 4, { gain: 0.035, top: 3000 });
      },
    },

    lovely: {
      name: "Lovely", line: "Warm, tender, someone you are glad is next to you.",
      colors: ["#ff9fb2", "#ffcb9a", "#8a3d5c"],
      bpm: 66, wet: 0.55, dry: 0.85, root: 53,
      chords: [[0, 4, 7, 11, 16], [-3, 4, 7, 12], [2, 5, 9, 12], [-5, 2, 7, 11]],
      scale: [0, 2, 4, 7, 9],
      start(L) { L.mel = 7; },
      step(L, t, s) {
        const m = this, sd = L.sd, per = 32, d = L.e.density;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          pad(L, L.ch.map((n) => mtof(m.root + n)), t, per * sd + 0.5, { type: "sine", type2: "triangle", a: 2, r: 3, gain: 0.06, cutoff: 1800, detune: 5, spread: 0.5 });
          pad(L, [mtof(m.root - 12 + L.ch[0])], t, per * sd, { type: "sine", a: 0.6, r: 2, gain: 0.06, cutoff: 400 });
        }
        const p = s % 4 === 0 ? 0.38 : s % 2 === 0 ? 0.12 : 0;
        if (p && R() < p * d) {
          L.mel = Math.max(0, Math.min(9, L.mel + pick([-2, -1, -1, 1, 1, 2, 0])));
          const n = m.root + 12 + 12 * Math.floor(L.mel / 5) + m.scale[L.mel % 5];
          pluck(L, mtof(n), t, { gain: 0.05, decay: 2.4, bright: 2400, pan: rpan(0.4) });
          if (R() < 0.22) pluck(L, mtof(n + 12), t + 3 * sd, { gain: 0.02, decay: 1.8, bright: 3000, pan: rpan(0.7) });
        }
      },
    },

    happy: {
      name: "Happy", line: "Windows down, sun on the dashboard, no hurry.",
      colors: ["#ffd36b", "#7fe0c2", "#e2793f"],
      bpm: 100, wet: 0.22, dry: 0.55, root: 55,
      chords: [[0, 4, 7, 12], [2, 7, 11, 14], [4, 9, 12, 16], [0, 5, 9, 12]],
      arp: [0, 1, 2, 3, 2, 1, 2, 3],
      step(L, t, s) {
        const m = this, sd = L.sd, d = L.e.density, b = s % 16;
        if (b === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          pad(L, L.ch.map((n) => mtof(m.root + n)), t, 16 * sd, { type: "sawtooth", type2: "triangle", a: 0.4, r: 1.2, gain: 0.04, cutoff: 1700, detune: 7, spread: 0.6 });
        }
        const p = (s % 4 === 0 ? 0.85 : 0.45) * d;
        if (R() < p) {
          const n = m.root + 12 + L.ch[m.arp[s % 8] % L.ch.length];
          pluck(L, mtof(n), t, { type: "triangle", gain: 0.035, decay: 0.55, bright: 3600, pan: (s % 8) / 7 - 0.5 });
        }
        if (b === 0 || b === 6 || b === 8) bass(L, mtof(m.root - 12 + L.ch[0]), t, 0.32, { gain: 0.07, cutoff: 450, type: "triangle", q: 1 });
        if (s % 8 === 0) thump(L, t, { gain: 0.1 * d, len: 0.3 });
        if (s % 4 === 2) tick(L, t, { gain: 0.016 * d, freq: 7500, len: 0.05, pan: 0.3 });
      },
    },

    thriller: {
      name: "Thriller", line: "A train you might be followed on. Keep looking ahead.",
      colors: ["#ff4b3e", "#b0233a", "#3a0f12"],
      bpm: 116, wet: 0.4, dry: 0.85, root: 45,
      chords: [[0, 7, 12, 15], [-4, 3, 8, 12], [0, 7, 12, 15], [1, 5, 8, 13]],
      ost: [0, 0, 12, 0, 0, 12, 0, 7, 0, 0, 12, 0, 0, 12, 3, 7],
      step(L, t, s) {
        const m = this, sd = L.sd, d = L.e.density, per = 32;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          pad(L, L.ch.map((n) => mtof(m.root + n)), t, per * sd, { type: "sawtooth", a: 2.5, r: 2.5, gain: 0.045, cutoff: 750, detune: 9, spread: 0.7 });
        }
        if (R() < 0.72 + 0.28 * d) {
          const sweep = 450 + 650 * (0.5 + 0.5 * Math.sin((s / 128) * Math.PI * 2));
          bass(L, mtof(m.root - 12 + L.ch[0] + m.ost[s % 16]), t, sd * 0.75, { gain: s % 4 === 0 ? 0.06 : 0.045, cutoff: sweep, q: 3 });
        }
        if (s % 2 === 0) tick(L, t, { gain: 0.012 * d, freq: 8500, len: 0.03, pan: -0.25 });
        if (s % 16 === 0) thump(L, t, { gain: 0.08, f0: 90, f1: 40, len: 0.3 });
        if (s % 16 === 3) thump(L, t, { gain: 0.05, f0: 90, f1: 40, len: 0.25 });
        if (s % 128 === 112) swell(L, t, 16 * sd, { gain: 0.03, top: 5000 });
      },
    },

    wonder: {
      name: "Wonder", line: "Mountains turning gold. The whole world, wider than you remembered.",
      colors: ["#8fe3d4", "#ffe2a3", "#2f6f8f"],
      bpm: 72, wet: 0.7, dry: 0.7, root: 52,
      chords: [[0, 7, 12, 16, 19], [5, 12, 17, 21], [-3, 4, 9, 12, 16], [-5, 2, 7, 11, 14]],
      step(L, t, s) {
        const m = this, sd = L.sd, per = 32, d = L.e.density;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          pad(L, L.ch.map((n) => mtof(m.root + n)), t, per * sd + 0.5, { type: "sawtooth", type2: "triangle", a: 3, r: 4, gain: 0.05, cutoff: 2000, detune: 9, spread: 0.85 });
          pad(L, [mtof(m.root - 12 + L.ch[0])], t, per * sd, { type: "sine", a: 2, r: 3, gain: 0.05, cutoff: 400 });
        }
        const b = s % 16;
        if (b < 10 && R() < 0.6 * d) {
          const tones = L.ch.concat(L.ch.map((n) => n + 12));
          pluck(L, mtof(m.root + 12 + tones[b % tones.length]), t, { type: "triangle", gain: 0.026, decay: 1.9, bright: 4200, pan: b / 9 - 0.5 });
        }
        if (R() < 0.025 * d) bell(L, mtof(m.root + 36 + pick(L.ch)), t, { gain: 0.02, decay: 5, ratio: 2, index: 0.8, pan: rpan(0.8) });
      },
    },

    fairytale: {
      level: 2.5,
      name: "Fairy tale", line: "Once upon a time, a little lantern in a big dark forest.",
      colors: ["#f5b8ff", "#a9d8ff", "#4b3a8f"],
      bpm: 126, wet: 0.55, dry: 0.8, root: 60, bar: 12,
      chords: [[0, 4, 7], [-3, 0, 4], [5, 9, 12], [-5, -1, 2]],
      scale: [0, 2, 4, 5, 7, 9, 11],
      start(L) { L.mel = 7; },
      step(L, t, s) {
        const m = this, sd = L.sd, per = 24, d = L.e.density, b = s % 12;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          pad(L, L.ch.map((n) => mtof(m.root + n)), t, per * sd, { type: "sine", a: 1, r: 2, gain: 0.03, cutoff: 1500, spread: 0.5 });
        }
        if (b === 0) pluck(L, mtof(m.root - 24 + L.ch[0]), t, { gain: 0.06, decay: 0.7, bright: 900 });
        if (b === 4 || b === 8) L.ch.forEach((n) => pluck(L, mtof(m.root + n), t, { gain: 0.016, decay: 0.35, bright: 2500, pan: rpan(0.3) }));
        if (s % 2 === 0 && R() < (b === 0 ? 0.6 : 0.3) * d) {
          L.mel = Math.max(0, Math.min(13, L.mel + pick([-2, -1, -1, 1, 1, 2])));
          const n = m.root + 12 + 12 * Math.floor(L.mel / 7) + m.scale[L.mel % 7];
          bell(L, mtof(n), t, { gain: 0.03, decay: 1.6, ratio: 2, index: 0.5, pan: rpan(0.5) });
        }
      },
    },

    melancholy: {
      level: 2.4,
      name: "Melancholy", line: "Rain on the window. The last day of the trip.",
      colors: ["#8aa0b8", "#5d6f8a", "#1d2738"],
      bpm: 60, wet: 0.8, dry: 0.75, root: 57,
      chords: [[0, 3, 7, 10], [-4, 0, 3, 7], [5, 8, 12], [-5, -2, 2, 7]],
      scale: [0, 3, 5, 7, 10],
      start(L) { L.mel = 5; L.rest = false; },
      step(L, t, s) {
        const m = this, sd = L.sd, per = 32, d = L.e.density, b = s % 16;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          pad(L, L.ch.map((n) => mtof(m.root - 12 + n)), t, per * sd, { type: "sine", a: 3, r: 4, gain: 0.03, cutoff: 900, spread: 0.4 });
          pluck(L, mtof(m.root - 24 + L.ch[0]), t, { gain: 0.06, decay: 4, bright: 900 });
        }
        if (b === 0) L.rest = R() < 0.3;
        if ((b === 4 || b === 8) && s % per < 16) pluck(L, mtof(m.root - 12 + pick(L.ch)), t, { gain: 0.03, decay: 3, bright: 1400, pan: rpan(0.3) });
        if (!L.rest && s % 4 === 0 && R() < 0.24 * d) {
          L.mel = Math.max(0, Math.min(9, L.mel + pick([-2, -1, -1, 1, 0, 1])));
          const n = m.root + 12 * Math.floor(L.mel / 5) + m.scale[L.mel % 5];
          pluck(L, mtof(n), t, { gain: 0.05, decay: 3.5, bright: 1800, pan: rpan(0.25) });
        }
      },
    },

    scifi: {
      level: 1.25,
      name: "Sci-fi", line: "A quiet station orbiting somewhere far. Lights blinking in sequence.",
      colors: ["#5ad1ff", "#7a6bff", "#0e2a4a"],
      bpm: 84, wet: 0.65, dry: 0.75, root: 48,
      chords: [[0, 7, 14, 16], [-2, 5, 12, 14], [3, 10, 15, 19], [5, 12, 17, 19]],
      arp: [0, 1, 2, 3, 1, 2, 3, 4, 2, 3, 4, 5, 3, 4, 5, 6],
      step(L, t, s) {
        const m = this, sd = L.sd, per = 64, d = L.e.density;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          pad(L, L.ch.map((n) => mtof(m.root + n)), t, per * sd, { type: "sawtooth", type2: "sawtooth", a: 5, r: 6, gain: 0.05, cutoff: 1100, detune: 12, spread: 0.9 });
          pad(L, [mtof(m.root - 12 + L.ch[0])], t, per * sd, { type: "sine", a: 4, r: 5, gain: 0.05, cutoff: 300 });
        }
        if (R() < 0.5 + 0.4 * d) {
          const tones = L.ch.concat(L.ch.map((n) => n + 12));
          const n = m.root + 12 + tones[m.arp[s % 16] % tones.length];
          const cut = 500 + 1700 * (0.5 + 0.5 * Math.sin((s / 96) * Math.PI * 2));
          pluck(L, mtof(n), t, { type: "sawtooth", gain: 0.02, decay: 0.35, bright: cut, pan: s % 2 ? 0.4 : -0.4 });
          if (s % 4 === 0) pluck(L, mtof(n), t + 3 * sd, { type: "sawtooth", gain: 0.008, decay: 0.3, bright: cut * 0.7, pan: s % 2 ? -0.6 : 0.6 });
        }
        if (R() < 0.012 * d) {
          const f = 1400 + R() * 1800;
          for (let i = 0; i < 1 + Math.floor(R() * 3); i++) pluck(L, f, t + i * 0.11, { gain: 0.01, decay: 0.09, bright: 9000, pan: rpan(0.9) });
        }
      },
    },

    neon: {
      level: 0.65,
      name: "Neon night", line: "City lights sliding past a taxi window at 2 a.m.",
      colors: ["#ff4fd8", "#41e6ff", "#2a0a4a"],
      bpm: 96, wet: 0.45, dry: 0.75, root: 52,
      chords: [[0, 3, 7, 12], [-4, 0, 3, 8], [3, 7, 10, 15], [-2, 2, 5, 10]],
      scale: [0, 3, 5, 7, 10],
      start(L) { L.leadUntil = 0; },
      step(L, t, s) {
        const m = this, sd = L.sd, d = L.e.density, b = s % 16;
        if (b === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          pad(L, L.ch.map((n) => mtof(m.root + n)), t, 16 * sd, { type: "sawtooth", a: 0.3, r: 0.8, gain: 0.03, cutoff: 1300, detune: 10, spread: 0.7 });
        }
        if (s % 2 === 0) bass(L, mtof(m.root - 24 + L.ch[0] + (s % 4 === 2 ? 12 : 0)), t, sd * 1.6, { gain: 0.05, cutoff: 550, q: 2 });
        if (s % 4 === 2 && R() < 0.8) pad(L, L.ch.map((n) => mtof(m.root + 12 + n)), t, sd * 1.2, { type: "square", a: 0.01, r: 0.15, gain: 0.012, cutoff: 2400 });
        if (s % 4 === 0) thump(L, t, { gain: 0.08 * d, len: 0.3 });
        if (b === 4 || b === 12) tick(L, t, { gain: 0.03 * d, freq: 1600, len: 0.2 });
        if (s % 2 === 1) tick(L, t, { gain: 0.008 * d, freq: 9000, len: 0.03, pan: 0.3 });
        if (s % 4 === 0 && t >= L.leadUntil && R() < 0.12 * d) {
          const dur = sd * pick([4, 6, 8]);
          lead(L, mtof(m.root + 12 + pick(m.scale) + 12 * (R() < 0.3 ? 1 : 0)), t, dur, { type: "square", cutoff: 1800, gain: 0.025, vib: 5.5, vibDepth: 10, a: 0.05, r: 0.6, pan: 0.15 });
          L.leadUntil = t + dur + sd * 2;
        }
      },
    },

    noir: {
      level: 4.5,
      name: "Noir", line: "Paris, 3 a.m. Wet cobblestones and a muted trumpet somewhere.",
      colors: ["#c9b38a", "#7d6a52", "#1a1714"],
      bpm: 70, wet: 0.6, dry: 0.8, root: 50,
      chords: [[0, 3, 7, 10, 14], [5, 8, 12, 15], [1, 5, 8, 12], [-5, -1, 2, 5]],
      blues: [0, 3, 5, 6, 7, 10, 12, 15],
      start(L) { L.phrase = []; L.leadUntil = 0; },
      step(L, t, s) {
        const m = this, sd = L.sd, per = 32, d = L.e.density, b = s % 16;
        if (s % per === 0) L.ch = m.chords[L.ci++ % m.chords.length];
        if (s % per === 0 || (s % per === 22 && R() < 0.5)) L.ch.forEach((n, i) => pluck(L, mtof(m.root + n), t + i * 0.012, { gain: 0.022, decay: 2.6, bright: 1400, pan: rpan(0.3) }));
        if (s % 4 === 0) {
          const n = b === 0 && s % per === 0 ? L.ch[0] : L.ch[0] + pick([0, 3, 5, 7, 10, -2]);
          pluck(L, mtof(m.root - 24 + n), t, { type: "triangle", gain: 0.065, decay: 0.7, bright: 650 });
          tick(L, t, { gain: 0.007 * d, freq: 3000, len: 0.25, pan: -0.2 });
        }
        if (s % 4 === 3) tick(L, t, { gain: 0.006 * d, freq: 7000, len: 0.08, pan: 0.3 });
        // muted trumpet: short phrases with breathing room
        if (t >= L.leadUntil && s % 2 === 0) {
          if (!L.phrase.length && R() < 0.1 * d) {
            let k = 2 + Math.floor(R() * 4), at = 0; L.phrase = [];
            while (k--) { const len = pick([2, 3, 4, 6]); L.phrase.push([at, len, pick(m.blues)]); at += len; }
            L.phraseStart = s;
          }
          if (L.phrase.length) {
            const [at, len, n] = L.phrase[0];
            if (s - L.phraseStart >= at) {
              L.phrase.shift();
              lead(L, mtof(m.root + 12 + n), t, len * sd * 0.9, { type: "sawtooth", band: true, cutoff: 1300, q: 3, gain: 0.04, vib: 5, vibDepth: 14, a: 0.06, r: 0.35, scoop: 60, pan: 0.2 });
              if (!L.phrase.length) L.leadUntil = t + sd * (8 + Math.floor(R() * 16));
            }
          }
        }
      },
    },

    mystery: {
      level: 0.6,
      name: "Mystery", line: "A detail nobody else noticed. Follow it quietly.",
      colors: ["#9be37a", "#4a7fb0", "#16242a"],
      bpm: 76, wet: 0.55, dry: 0.8, root: 50,
      chords: [[0, 3, 6, 9], [0, 3, 6, 10], [-1, 2, 5, 8], [0, 3, 6, 10]],
      oct: [0, 1, 3, 4, 6, 7, 9, 10],
      start(L) { L.mel = 8; },
      step(L, t, s) {
        const m = this, sd = L.sd, per = 64, d = L.e.density;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          pad(L, L.ch.map((n) => mtof(m.root + n)), t, per * sd, { type: "sine", a: 4, r: 4, gain: 0.03, cutoff: 900, spread: 0.6 });
        }
        if (s % 16 === 0) bass(L, mtof(m.root - 12 + L.ch[0]), t, sd * 6, { type: "triangle", gain: 0.05, cutoff: 400, q: 1 });
        if (s % 2 === 0 && R() < 0.62 * d) {
          L.mel = Math.max(0, Math.min(15, L.mel + pick([-1, -1, 1, 1, 2, -2, 0])));
          const n = m.root + 12 * Math.floor(L.mel / 8) + m.oct[L.mel % 8];
          pluck(L, mtof(n), t, { type: "triangle", gain: 0.045, decay: 0.28, bright: 1600, pan: rpan(0.5) });
        }
        if (s % 4 === 0) tick(L, t, { band: true, gain: 0.02 * d, freq: 2600, len: 0.05, pan: -0.4 });
        if (R() < 0.02 * d) bell(L, mtof(m.root + 24 + pick(m.oct)), t, { gain: 0.02, decay: 2.5, ratio: 3, index: 1, pan: rpan(0.8) });
      },
    },

    spy: {
      level: 2.8,
      name: "Spy", line: "Sunglasses, a borrowed name, and a car waiting downstairs.",
      colors: ["#ffb84a", "#3fa7a0", "#14202a"],
      bpm: 120, wet: 0.4, dry: 0.75, root: 52,
      chords: [[0, 3, 7, 11], [0, 3, 7, 11], [5, 8, 12, 16], [-5, -1, 2, 6]],
      line_: [0, null, 0, 3, null, 5, 4, null, 3, null, 0, null, 7, null, 6, 5],
      start(L) { L.leadUntil = 0; },
      step(L, t, s) {
        const m = this, sd = L.sd, per = 32, d = L.e.density, b = s % 16;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          pad(L, L.ch.map((n) => mtof(m.root + n)), t, per * sd, { type: "triangle", type2: "sine", a: 1.5, r: 2, gain: 0.035, cutoff: 1300, spread: 0.6 });
        }
        const n = m.line_[b];
        if (n !== null && R() < 0.75 + 0.25 * d) pluck(L, mtof(m.root - 12 + L.ch[0] + n), t, { type: "sawtooth", gain: 0.04, decay: 0.45, bright: 1700, pan: -0.2 });
        if (b === 4 || b === 12) strum(L, L.ch.map((x) => mtof(m.root + x)), t, { type: "sawtooth", gain: 0.012, decay: 0.3, bright: 2400, spread: 0.012 });
        if (s % 2 === 0) tick(L, t, { gain: (s % 4 === 2 ? 0.016 : 0.009) * d, freq: 8000, len: 0.05, pan: 0.35 });
        if (b === 0 && t >= L.leadUntil && R() < 0.25 * d) {
          const top = m.root + 12 + L.ch[3];
          lead(L, mtof(top), t, sd * 6, { type: "sawtooth", cutoff: 1600, gain: 0.03, vib: 6, vibDepth: 8, a: 0.03, r: 0.6, scoop: 80, pan: 0.25 });
          L.leadUntil = t + sd * 32;
        }
      },
    },

    western: {
      level: 2.4,
      name: "Western", line: "Long straight road, dust in the light, a canyon echo.",
      colors: ["#f2a65a", "#c8553d", "#3a2414"],
      bpm: 84, wet: 0.7, dry: 0.75, root: 50,
      chords: [[0, 7, 12], [5, 12, 17], [0, 7, 12], [-5, 2, 7]],
      penta: [0, 2, 4, 7, 9],
      start(L) { L.leadUntil = 0; L.mel = 5; },
      step(L, t, s) {
        const m = this, sd = L.sd, per = 32, d = L.e.density, b = s % 16;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          pad(L, L.ch.map((n) => mtof(m.root + n)), t, per * sd, { type: "triangle", a: 2.5, r: 3, gain: 0.035, cutoff: 1100, spread: 0.6 });
          if (R() < 0.8) strum(L, L.ch.concat([L.ch[0] + 16]).map((n) => mtof(m.root + n)), t, { type: "sawtooth", gain: 0.022, decay: 1.6, bright: 2200, spread: 0.03 });
        }
        if (s % 8 === 0) pluck(L, mtof(m.root - 12 + L.ch[0]), t, { type: "triangle", gain: 0.055, decay: 0.45, bright: 700 });
        if (s % 8 === 4) pluck(L, mtof(m.root - 12 + L.ch[0] + 7), t, { type: "triangle", gain: 0.04, decay: 0.4, bright: 700 });
        if (s % 4 === 0 || s % 4 === 3) tick(L, t, { band: true, gain: 0.014 * d, freq: 1100, len: 0.06, pan: rpan(0.2) });
        if (s % 4 === 0 && t >= L.leadUntil && R() < 0.16 * d) {
          L.mel = Math.max(0, Math.min(9, L.mel + pick([-2, -1, 1, 2, 3, -3])));
          const dur = sd * pick([6, 8, 12]);
          lead(L, mtof(m.root + 24 + 12 * Math.floor(L.mel / 5) - 12 + m.penta[L.mel % 5]), t, dur, { type: "sine", cutoff: 4000, gain: 0.03, vib: 5.5, vibDepth: 16, a: 0.12, r: 0.8, scoop: 40, pan: 0.15 });
          L.leadUntil = t + dur + sd * 4;
        }
      },
    },

    epic: {
      level: 1.4,
      name: "Epic", line: "The road climbs, the clouds open. This is the part they'll remember.",
      colors: ["#ffc65c", "#d9533f", "#1e2a4f"],
      bpm: 80, wet: 0.6, dry: 0.75, root: 50,
      chords: [[0, 7, 12, 15], [-4, 3, 8, 12], [3, 10, 15, 19], [-2, 5, 10, 14]],
      start(L) { L.leadUntil = 0; },
      step(L, t, s) {
        const m = this, sd = L.sd, per = 32, d = L.e.density, b = s % 16;
        if (s % per === 0) {
          L.ch = m.chords[L.ci++ % m.chords.length];
          pad(L, L.ch.map((n) => mtof(m.root + n)), t, per * sd, { type: "sawtooth", type2: "sawtooth", a: 2, r: 3, gain: 0.055, cutoff: 1500, detune: 10, spread: 0.9 });
          pad(L, [0, 7].map((n) => mtof(m.root - 12 + L.ch[0] + n)), t, per * sd, { type: "sawtooth", a: 1.5, r: 2.5, gain: 0.04, cutoff: 450 });
        }
        if (s % 2 === 0 && R() < 0.55 + 0.4 * d) pluck(L, mtof(m.root + L.ch[(s / 2) % L.ch.length]), t, { type: "sawtooth", gain: 0.018, decay: 0.3, bright: 1700, pan: rpan(0.4) });
        if (b === 0) thump(L, t, { gain: 0.12, f0: 75, f1: 46, len: 1.2 });
        if (b === 10) thump(L, t, { gain: 0.07, f0: 75, f1: 46, len: 0.9 });
        if (s % 128 >= 120) thump(L, t, { gain: 0.03 + 0.012 * (s % 128 - 120), f0: 80, f1: 50, len: 0.5 });
        if (b === 0 && t >= L.leadUntil && R() < 0.45 * d) {
          lead(L, mtof(m.root + 12 + pick(L.ch)), t, sd * 12, { type: "sawtooth", cutoff: 900, q: 0.7, gain: 0.035, vib: 4.5, vibDepth: 8, a: 0.5, r: 1.2, pan: -0.15 });
          L.leadUntil = t + sd * 16;
        }
      },
    },
  };
  const ORDER = ["dreamy", "lovely", "happy", "wonder", "fairytale", "melancholy", "scifi", "neon", "noir", "mystery", "spy", "western", "epic", "scary", "thriller"];

  /* ---------- engine ---------- */
  class Engine {
    constructor(ctx) {
      this.ctx = ctx;
      this.density = 1;
      this.noise = makeNoise(ctx, 3);
      this.out = ctx.createGain();           // play / pause fader
      this.master = ctx.createGain();        // presence (intensity)
      const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 35;
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -20; this.comp.ratio.value = 3;
      this.comp.attack.value = 0.05; this.comp.release.value = 0.4; this.comp.knee.value = 12;
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = makeIR(ctx, 5.5, 2.6);
      this.dry = ctx.createGain();
      this.dry.connect(hp); this.reverb.connect(hp);
      hp.connect(this.master); this.master.connect(this.comp); this.comp.connect(this.out);
      this.layers = [];
      this.setIntensity(0.5);
    }
    setIntensity(v, at) {
      this.intensity = v;
      const g = 0.06 + 0.94 * Math.pow(v, 1.6);
      this.density = 0.55 + 0.9 * v;
      const t = at == null ? this.ctx.currentTime : at;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(g, t, 0.4);
    }
    addLayer(key, t, fade) {
      const ctx = this.ctx, mood = MOODS[key];
      const L = {
        e: this, ctx, key, mood, t0: t, next: t, s: 0, ci: 0, ch: mood.chords ? mood.chords[0] : [0],
        sd: 60 / mood.bpm / 4, continuous: [], stopped: false,
      };
      L.fade = ctx.createGain();
      L.fade.gain.setValueAtTime(0, t);
      L.fade.gain.linearRampToValueAtTime(1, t + fade);
      L.bus = ctx.createGain();
      L.bus.gain.value = mood.level || 1;   // per-mood loudness trim
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
      L.continuous.forEach((nodes) => nodes.forEach((n) => { try { n.stop(t + fade + 0.2); } catch (e) {} }));
    }
    // Schedule every layer's notes up to time `until`.
    schedule(until) {
      for (const L of this.layers) {
        const stopAt = L.stopped ? L.end : Infinity;
        while (L.next < until && L.next < stopAt) {
          L.mood.step(L, L.next, L.s);
          L.s++; L.next += L.sd;
        }
      }
      // drop layers that have fully faded (keep tails for 8s)
      const now = this.ctx.currentTime;
      this.layers = this.layers.filter((L) => {
        if (L.stopped && now > L.end + 8) { try { L.fade.disconnect(); } catch (e) {} return false; }
        return true;
      });
    }
  }

  /* ---------- offline: a seamless loop for lock-screen playback ---------- */
  async function renderLoop(key, intensity, opts = {}) {
    const sr = opts.sampleRate || 32000;
    const W = 8, LEN = opts.seconds || 150, X = 6;
    const total = W + LEN + X + 1;
    const OAC = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    const off = new OAC(2, Math.ceil(sr * total), sr);
    const e = new Engine(off);
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

  const api = { Engine, MOODS, ORDER, renderLoop, encodeWAV };
  root.TripEngine = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
