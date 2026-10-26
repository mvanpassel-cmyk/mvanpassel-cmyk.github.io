/* Trip Score — composed moods (v2). Loaded after engine.js; replaces Dreamy and Noir.

   The idea: a mood is a small composer with a memory, not a set of probabilities.
   - Chapters of a few minutes are planned as an arc of sections (alone, bloom, song, drift, lift, settle, silence).
   - Each section is written phrase by phrase. A phrase has a harmonic plan (with pedal points, modal
     interchange, extended chords and some unresolved endings), a texture, and often the mood's motif.
   - The motif is remembered and transformed: plain, fragment, inversion, sequence, augmentation, echo.
     The emotional "lift" (motif augmented on the solo violin / trumpet) happens at most once per chapter.
   - Melody is fitted to the harmony with tensions allowed (9ths, 13ths, #11) and prepared appoggiaturas,
     instead of forcing every note onto a chord tone.
   - Silence is part of the form: breaths between phrases and whole near-silent passages.
   Instruments: Salamander Grand Piano (Alexander Holm, CC BY 3.0) and VSCO 2 Community Edition (CC0). */
(function (root) {
  "use strict";
  const E = root.TripEngine;
  if (!E || !E.lib) return;
  const { bowed, DYN, layersOf } = E.lib;
  const R = Math.random;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const pc = (n) => ((n % 12) + 12) % 12;
  const pick = (a) => a[Math.floor(R() * a.length)];
  function wpick(obj) {               // weighted pick from {key: weight}
    const ks = Object.keys(obj), tot = ks.reduce((s, k) => s + obj[k], 0);
    let x = R() * tot;
    for (const k of ks) { x -= obj[k]; if (x <= 0) return k; }
    return ks[ks.length - 1];
  }

  // Dynamic layers for the new string, brass and wind recordings (soft, loud).
  Object.assign(DYN, {
    vlns: ["vlns_p", "vlns_f"], vlas: ["vlas_p", "vlas_f"], vcs: ["vcs_p", "vcs_f"],
    mutetpt: ["mutetpt_p", "mutetpt_f"], clar2: ["clar2_p", "clar2_f"],
  });

  /* ---------- a sampler note with articulation (bends, filters, velocity layers) ---------- */
  function nearest(notes, m) {
    let best = notes[0], bd = 1e9;
    for (const n of notes) { const d = Math.abs(n.m - m) + (n.m > m ? 0.01 : 0); if (d < bd) { bd = d; best = n; } }
    return best;
  }
  function out(L, pan, dest) {
    const ctx = L.ctx, g = ctx.createGain();
    g.gain.value = 0;
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = clamp(pan || 0, -1, 1); g.connect(p); p.connect(dest || L.bus); }
    else g.connect(dest || L.bus);
    return g;
  }
  function note(L, inst, m, t, o = {}) {
    const b = L.e.bank.get(inst);
    if (!b) return;
    const ctx = L.ctx; t = Math.max(0, t);
    const n = nearest(b.notes, m), rate = Math.pow(2, (m - n.m) / 12);
    const avail = n.d / rate, len = Math.min(o.dur == null ? avail : o.dur, avail);
    const src = ctx.createBufferSource();
    src.buffer = b.buffer; src.playbackRate.value = rate;
    src.detune.value = (R() - 0.5) * (o.human == null ? 4 : o.human);
    const g = out(L, o.pan, o.dest);
    let node = src;
    if (o.lp) { const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = o.lp; f.Q.value = 0.4; node.connect(f); node = f; }
    node.connect(g);
    const a = o.a || 0.003, r = o.r == null ? 0.3 : o.r, peak = o.gain == null ? 0.3 : o.gain;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    let end = t + avail;
    if (len < avail - 0.02) {
      g.gain.setValueAtTime(peak, t + Math.max(a, len));
      g.gain.setTargetAtTime(0, t + Math.max(a, len), r / 4);
      end = t + Math.max(a, len) + r * 1.5;
    }
    if (o.bend) {   // fall-off at the end of a note (muted trumpet)
      const tb = t + Math.max(a, len - o.bend.time);
      src.playbackRate.setValueAtTime(rate, tb);
      src.playbackRate.exponentialRampToValueAtTime(rate * Math.pow(2, o.bend.semis / 12), tb + o.bend.time);
    }
    src.start(t, n.o, Math.min(n.d, (end - t) * rate + 0.05));
    src.stop(end + 0.05);
  }
  // Piano: velocity 0..1 chooses the recorded layer and the level inside it.
  function piano(L, m, t, vel, o = {}) {
    vel = clamp(vel, 0.02, 1);
    const layer = vel < 0.34 ? "piano2_pp" : vel < 0.67 ? "piano2_mp" : "piano2_mf";
    const within = (vel % 0.335) / 0.335;
    const gain = (o.gain || 0.42) * (0.55 + 0.45 * within) * (layer === "piano2_pp" ? 1.35 : layer === "piano2_mp" ? 1 : 0.85);
    // gentle tilt: low notes slightly left, high notes slightly right (player's perspective)
    note(L, layer, m, t, { gain, dur: o.dur, r: o.r == null ? 0.45 : o.r, pan: o.pan == null ? clamp((m - 62) / 60, -0.35, 0.35) : o.pan, lp: o.lp, human: 2 });
  }

  /* ---------- brushes (synthesised: there are no brush recordings in the free library) ---------- */
  function noiseBuf(ctx) {
    if (ctx._tsNoise) return ctx._tsNoise;
    const len = ctx.sampleRate * 2, b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) { const w = R() * 2 - 1; b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0527; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
    return (ctx._tsNoise = b);
  }
  function brushBar(L, t, beat, level, taps) {
    const ctx = L.ctx, src = ctx.createBufferSource();
    src.buffer = noiseBuf(ctx); src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 2400; bp.Q.value = 0.7;
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 900;
    const g = out(L, 0.12);
    src.connect(hp); hp.connect(bp); bp.connect(g);
    // two circular sweeps per bar, leaning into beats 2 and 4
    const lv = level * 0.06;
    g.gain.setValueAtTime(0.0001, t);
    for (let k = 0; k < 2; k++) {
      const s0 = t + k * 2 * beat;
      g.gain.linearRampToValueAtTime(lv * 0.35, s0 + 0.35 * beat);
      g.gain.linearRampToValueAtTime(lv, s0 + beat * 0.98);
      g.gain.linearRampToValueAtTime(lv * 0.25, s0 + beat * 1.6);
    }
    g.gain.linearRampToValueAtTime(0.0001, t + 4 * beat);
    bp.frequency.setValueAtTime(2000, t); bp.frequency.linearRampToValueAtTime(2900, t + 2 * beat); bp.frequency.linearRampToValueAtTime(2000, t + 4 * beat);
    src.start(t, R() * 1.5); src.stop(t + 4 * beat + 0.05);
    if (taps) [1, 3].forEach((b) => {   // soft tap on 2 and 4
      const s = ctx.createBufferSource(); s.buffer = noiseBuf(ctx);
      const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1800 + R() * 400; f.Q.value = 1.1;
      const gg = out(L, 0.18); s.connect(f); f.connect(gg);
      const tt = t + b * beat + (R() - 0.5) * 0.012;
      gg.gain.setValueAtTime(0, tt); gg.gain.linearRampToValueAtTime(level * 0.1, tt + 0.004); gg.gain.setTargetAtTime(0, tt + 0.006, 0.035);
      s.start(tt, R()); s.stop(tt + 0.25);
    });
  }

  /* ---------- harmony helpers ---------- */
  // Chord: { bass, tones (core: root 3 5 7), ext (9, 11, 13 allowed as colour), avoid (pcs a melody must not dwell on) } relative to key.
  const abs = (key, x) => key + x;
  // Voice an upper structure in a range, close and smooth from the previous voicing.
  function voiceUpper(prev, pcs, lo, hi, n) {
    const cands = [];
    for (let m = lo; m <= hi; m++) if (pcs.includes(pc(m))) cands.push(m);
    let best = null, bestCost = 1e9;
    const rec = (start, chosen) => {
      if (chosen.length === n) {
        const used = new Set(chosen.map(pc));
        let cost = (pcs.length - used.size) * 4;
        for (let i = 1; i < n; i++) { const d = chosen[i] - chosen[i - 1]; if (d === 1 || d === 2 && chosen[i] < 60) cost += 6; if (d > 9) cost += 2; }
        if (prev && prev.length === n) for (let i = 0; i < n; i++) cost += Math.abs(chosen[i] - prev[i]) * 0.6;
        else cost += chosen.reduce((s, m) => s + Math.abs(m - (lo + hi) / 2), 0) * 0.1;
        if (cost < bestCost) { bestCost = cost; best = chosen.slice(); }
        return;
      }
      for (let i = start; i < cands.length; i++) {
        if (chosen.length && cands[i] - chosen[chosen.length - 1] < 2) continue;
        if (chosen.length && cands[i] - chosen[0] > 16) break;
        chosen.push(cands[i]); rec(i + 1, chosen); chosen.pop();
      }
    };
    rec(0, []);
    return best || cands.slice(0, n);
  }
  // Generate a phrase of chords by walking the mood's harmonic graph, ending on the cadence type requested.
  function progression(m, from, n, ending, avoidSeq) {
    for (let tries = 0; tries < 30; tries++) {
      const seq = [];
      let cur = from;
      for (let i = 0; i < n; i++) {
        const opts = Object.assign({}, m.graph[cur] || m.graph[m.home]);
        if (i === n - 1) {   // last chord: bias towards the requested ending
          for (const k of Object.keys(opts)) if (!(m.endings[ending] || []).includes(k)) opts[k] *= 0.08;
        }
        if (seq.length && opts[seq[seq.length - 1]]) opts[seq[seq.length - 1]] *= 0.25;   // avoid immediate repeats
        cur = wpick(opts); seq.push(cur);
      }
      if (avoidSeq && seq.join() === avoidSeq) continue;
      return seq;
    }
    return [from];
  }

  /* ---------- motif: memory and transformation ---------- */
  // Motif notes are [scale-degree offset (in semitones from the tonic), beats]. null = rest.
  function transform(motif, how, scale) {
    const deg = (s) => { const o = Math.floor(s / 12), p = pc(s); let i = scale.indexOf(p); if (i < 0) i = scale.findIndex((q) => q > p) - 1; return i + 7 * o; };
    const fromDeg = (d) => scale[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
    const shift = (k) => motif.map(([s, b]) => [s == null ? null : fromDeg(deg(s) + k), b]);
    switch (how) {
      case "plain": return motif.slice();
      case "fragment": return motif.slice(0, Math.max(2, Math.ceil(motif.length / 2)));
      case "echo": { const f = motif.slice(0, 2); return f.concat([[null, 1]], f.map(([s, b]) => [s, b * 1.5])); }
      case "seqUp": return shift(1);
      case "seqDown": return shift(-2);
      case "invert": { const d0 = deg(motif[0][0]); return motif.map(([s, b]) => [s == null ? null : fromDeg(2 * d0 - deg(s)), b]); }
      case "augment": return motif.map(([s, b]) => [s, b * 2]);
      case "answer": { const m2 = motif.slice(0, -1); return m2.concat([[0, motif[motif.length - 1][1] + 1]]); }   // resolve to the tonic
      case "ornament": {
        const outp = [];
        motif.forEach(([s, b], i) => {
          if (s != null && b >= 2 && i < motif.length - 1 && R() < 0.6) { outp.push([fromDeg(deg(s) + 1), 0.5]); outp.push([s, b - 0.5]); }
          else outp.push([s, b]);
        });
        return outp;
      }
      default: return motif.slice();
    }
  }

  // Fit a line of [semitone, beats] over a chord timeline: choose a diatonic transposition and octave where
  // strong notes are chord tones or allowed tensions, and anything rubbing is short and resolves by step.
  function fitLine(line, timeline, m, range, beat) {
    let best = null, bestScore = 1e9;
    const scale = m.scale;
    const deg = (s) => { const o = Math.floor(s / 12), p = pc(s); let i = scale.indexOf(p); if (i < 0) i = 0; return i + 7 * o; };
    const fromDeg = (d) => scale[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
    for (let k = -3; k <= 3; k++) for (const oct of [-24, -12, 0, 12, 24]) {
      let score = Math.abs(k) * 0.6, pos = 0;
      const notes = [];
      for (let i = 0; i < line.length; i++) {
        const [s, b] = line[i];
        if (s == null) { pos += b; continue; }
        const midi = m.key + oct + fromDeg(deg(s) + k);
        if (midi < range[0] || midi > range[1]) score += 30;
        const ch = chordAt(timeline, pos * beat);
        const rel = pc(midi - m.key);
        const strong = b >= 1 || Math.abs(pos - Math.round(pos)) < 0.01 && Math.round(pos) % 2 === 0;
        if (ch.tones.includes(rel)) score += 0;
        else if (ch.ext.includes(rel)) score += strong ? 0.6 : 0.2;
        else if (ch.avoid.includes(rel)) {
          const nx = line.slice(i + 1).find((x) => x[0] != null);
          const resolves = nx && Math.abs((m.key + oct + fromDeg(deg(nx[0]) + k)) - midi) <= 2 && b <= 1.5;
          score += resolves ? (strong ? 1.5 : 0.8) : (strong ? 9 : 3);
        } else score += strong ? 3 : 0.8;
        notes.push({ midi, at: pos, beats: b });
        pos += b;
      }
      score += R() * 1.6;   // controlled freedom: several good fits are all acceptable
      if (score < bestScore) { bestScore = score; best = notes; }
    }
    return best;
  }
  function chordAt(timeline, t) {
    for (const c of timeline) if (t >= c.t0 - 1e-6 && t < c.t1 - 1e-6) return c.ch;
    return timeline[timeline.length - 1].ch;
  }

  /* ---------- the generic composer: chapters → sections → phrases ---------- */
  function planChapter(L, m) {
    const sc = L.sc;
    sc.chapter = (sc.chapter || 0) + 1;
    const tpl = m.chapters[(sc.chapter - 1) % m.chapters.length];
    // the template gives the arc; each section may be swapped for a sibling so no chapter repeats exactly
    const names = [];
    tpl.forEach((name, i) => {
      const alt = (m.siblings[name] || []).filter((x) => x !== names[i - 1] && x !== tpl[i + 1]);
      names.push(alt.length && R() < 0.35 ? pick(alt) : name);
    });
    const secs = names.map((nm) => {
      return Object.assign({ name: nm }, m.sections[nm], { phrasesLeft: m.sections[nm].phrases[0] + Math.floor(R() * (m.sections[nm].phrases[1] - m.sections[nm].phrases[0] + 1)) });
    });
    sc.queue = secs;
    sc.liftDone = false;
  }
  function chooseMotifForm(L, m, sec) {
    const sc = L.sc;
    const forms = sec.motifForms;
    let f = pick(forms);
    if (f === sc.lastForm && forms.length > 1) f = pick(forms.filter((x) => x !== f));
    sc.lastForm = f;
    return f;
  }
  function composePhrase(L, m, at) {
    const sc = L.sc;
    if (!sc.queue || !sc.queue.length) planChapter(L, m);
    const sec = sc.queue[0];
    if (sec.name === "lift" && sc.liftDone) { sc.queue.shift(); return composePhrase(L, m, at); }
    const tempo = m.bpm * (sec.tempo || 1) * (0.985 + R() * 0.03);
    const beat = 60 / tempo, bar = beat * m.beats;
    // harmony for this phrase
    const nCh = Math.max(1, (sec.chords || 4) + (sec.chords >= 3 ? pick([-1, 0, 0, 0, 1]) : 0));
    const ending = sec.phrasesLeft === 1 ? (sec.lastEnding || "answer") : (sc.prevEnding === "question" ? "answer" : "question");
    sc.prevEnding = ending;
    const names = sec.pedalOnly ? [sc.lastChord && m.pedalOk.includes(sc.lastChord) ? sc.lastChord : m.home] :
      progression(m, sc.lastChord || m.home, nCh, ending, sc.lastSeq);
    sc.lastSeq = names.join(); sc.lastChord = names[names.length - 1];
    const bpc = sec.barsPerChord || 1;
    const timeline = names.map((nm, i) => ({ name: nm, ch: m.chords[nm], t0: i * bpc * bar, t1: (i + 1) * bpc * bar }));
    // phrases are not all the same length: sometimes the last chord is held a bar longer (cadential breath)
    if (!sec.pedalOnly && R() < 0.3) timeline[timeline.length - 1].t1 += bar;
    const total = timeline[timeline.length - 1].t1;
    const intensity = clamp((sec.level || 0.4) * (0.75 + 0.5 * L.e.intensity), 0, 1);
    // motif
    let line = null;
    if (sec.motif && R() < (sec.motifChance == null ? 1 : sec.motifChance)) {
      const form = chooseMotifForm(L, m, sec);
      let base = m.motif;
      if (ending === "answer" && form !== "fragment" && form !== "echo") base = transform(base, "answer", m.scale);
      line = transform(base, form, m.scale);
      if (sec.name === "lift") { line = transform(line, "augment", m.scale); sc.liftDone = true; }
      sc.motifCount = (sc.motifCount || 0) + 1;
    }
    const ctx = { L, m, sec, at, beat, bar, timeline, total, intensity, line, names, ending };
    sec.write(ctx);
    if (root.TS_DEBUG) root.TS_DEBUG.push({ t: +at.toFixed(1), sec: sec.name, ch: names.join(' '), motif: line ? (sc.lastForm || '') : '', len: +total.toFixed(1), chapter: sc.chapter, ending });
    sec.phrasesLeft--;
    sc.phraseIdx = (sc.phraseIdx || 0) + 1;
    let rest = sec.breath ? sec.breath[0] + R() * (sec.breath[1] - sec.breath[0]) : 0;
    if (sc.phraseIdx <= 2) rest *= 0.3;   // the opening should establish the mood, not wait
    if (sec.phrasesLeft <= 0) { sc.queue.shift(); rest += sec.after || 0; }
    // quiet sections get a barely audible sustained bed, so silence never sounds like the app stopped
    if (sec.bed && m.bed) m.bed(ctx, total + rest);
    return total + rest;
  }
  // Per-mood tone shaping between the mood's bus and its fader.
  function eqStart(m) {
    return function (L) {
      if (!m.eq) return;
      const ctx = L.ctx, ls = ctx.createBiquadFilter(), hs = ctx.createBiquadFilter(), pk = ctx.createBiquadFilter();
      ls.type = "lowshelf"; ls.frequency.value = m.eq.lowF || 160; ls.gain.value = m.eq.low || 0;
      pk.type = "peaking"; pk.frequency.value = m.eq.midF || 350; pk.Q.value = 0.9; pk.gain.value = m.eq.mid || 0;
      hs.type = "highshelf"; hs.frequency.value = m.eq.highF || 4200; hs.gain.value = m.eq.high || 0;
      try { L.bus.disconnect(); } catch (e) {}
      L.bus.connect(ls); ls.connect(pk); pk.connect(hs); hs.connect(L.fade);
    };
  }
  function makeStep(m) {
    return function (L, t) {
      const sc = L.sc || (L.sc = { nextAt: t + 0.25 });
      if (t + 1.2 >= sc.nextAt) sc.nextAt += composePhrase(L, m, sc.nextAt);
    };
  }

  /* ---------- part writers ---------- */
  // Place a fitted line on an instrument with phrasing: slight rubato, dynamic arch, natural overlaps.
  function playLine(c, notes, inst, o = {}) {
    if (!notes || !notes.length) return;
    const { L, beat, at } = c;
    const peakIdx = notes.reduce((bi, n, i, a) => (n.midi > a[bi].midi ? i : bi), 0);
    notes.forEach((n, i) => {
      const arch = 1 - 0.35 * Math.abs(i - peakIdx) / Math.max(1, notes.length - 1);
      const last = i === notes.length - 1;
      const rub = last ? beat * 0.08 : 0;                         // a little breath before the last note
      const t = at + n.at * beat + rub + (R() - 0.5) * 0.02 + (o.late || 0);
      const dur = n.beats * beat * (last ? 1.15 : 1) + (o.overlap || 0.06);
      const vel = clamp((o.vel || 0.5) * arch * (0.85 + 0.3 * c.intensity), 0.05, 1);
      if (inst === "piano") piano(L, n.midi, t, vel, { dur: Math.max(dur, beat * 1.2), gain: o.gain, r: 0.8 });
      else if (DYN[inst]) bowed(L, inst, n.midi, t, dur, { gain: o.gain || 0.2, d0: vel * 0.75 * (o.dynCap || 1), d1: vel * (o.dynCap || 1), cutoff: o.cutoff, swell: n.beats >= 2 ? 0.18 : 0.06, a: o.a || Math.min(0.35, n.beats * beat * 0.3), r: o.r || 0.9, pan: o.pan });
      else note(L, inst, n.midi, t, { gain: (o.gain || 0.2) * (0.6 + 0.6 * vel), dur, a: o.a || 0.05, r: o.r || 0.6, pan: o.pan,
        bend: last && o.fall && R() < o.fall ? { time: 0.45, semis: -2.5 } : null });
    });
  }
  // Long string chords from the timeline. `voices` picks which sections play; entries can be staggered.
  function stringPad(c, voices, o = {}) {
    const { L, m, at, timeline } = c;
    const sc = L.sc;
    timeline.forEach((seg, i) => {
      const ch = seg.ch, dur = seg.t1 - seg.t0;
      const melodyPcs = c.line ? new Set() : null;
      const pcs = ch.tones.map((x) => pc(m.key + x)).concat((o.ext ? ch.ext.slice(0, 1) : []).map((x) => pc(m.key + x)));
      const up = voiceUpper(sc.padPrev, pcs, o.lo || 52, o.hi || 76, voices.filter((v) => v !== "vcs").length || 1);
      sc.padPrev = up;
      const d0 = clamp(c.intensity * 0.6, 0.08, 0.8), d1 = clamp(c.intensity * (o.grow ? 0.85 : 0.6), 0.08, 0.9);
      let k = 0;
      voices.forEach((v) => {
        const late = (o.stagger ? R() * 0.8 * c.beat : 0) + R() * 0.03;
        if (v === "vcs") {
          const bass = nearestIn(m.key + ch.bass, o.bassLo || 40, o.bassHi || 55, sc.bassPrev);
          sc.bassPrev = bass;
          bowed(L, "vcs", bass, at + seg.t0 + late, dur + 0.3, { gain: o.gainBass || 0.12, d0, d1, swell: 0.12, a: 1.0, r: 1.6, pan: 0.38 });
        } else {
          const mm = up[k++ % up.length];
          bowed(L, v, mm, at + seg.t0 + late, dur + 0.3, { gain: o.gain || 0.12, d0, d1, swell: 0.1, a: 1.2, r: 1.6, pan: v === "vlns" ? -0.42 : 0.18 });
        }
      });
    });
  }
  function nearestIn(base, lo, hi, prev) {
    let best = null;
    for (let x = lo; x <= hi; x++) if (pc(x) === pc(base) && (best == null || Math.abs(x - (prev || (lo + hi) / 2)) < Math.abs(best - (prev || (lo + hi) / 2)))) best = x;
    return best;
  }

  /* ======================================================================
     DREAMY — piano with soft strings. D major with Lydian and borrowed colours.
     ====================================================================== */
  const dreamy = {
    name: "Dreamy", line: "Half-awake, floating, slow light through a window.",
    colors: ["#7f9cff", "#c3a2ff", "#3b3f8f"],
    uses: ["piano2_pp", "piano2_mp", "piano2_mf"].concat(layersOf(["vlns", "vlas", "vcs"]), ["solovln", "harp2"]),
    bpm: 60, beats: 4, key: 62, wet: 0.62, dry: 0.78, level: 1.86,
    eq: { low: -5, lowF: 170, mid: -2, midF: 320, high: 4, highF: 3800 },
    scale: [0, 2, 4, 6, 7, 9, 11],      // Lydian D: the raised 4th gives the floating quality
    home: "I",
    chords: {   // tones = core, ext = colour tensions (allowed on strong beats), avoid = rubs unless resolved
      I:     { bass: 0,  tones: [0, 4, 7, 11], ext: [2, 6, 9], avoid: [5] },
      Iadd9: { bass: 0,  tones: [0, 4, 7], ext: [2, 9, 11, 6], avoid: [5] },
      I3:    { bass: 4,  tones: [0, 4, 7], ext: [2, 11], avoid: [5] },          // D/F#
      II:    { bass: 4,  tones: [4, 8, 11, 2], ext: [6, 1], avoid: [7] },       // E major (Lydian II) over E: E G# B D
      ii9:   { bass: 4,  tones: [4, 7, 11, 2], ext: [6], avoid: [5] },          // Em9
      IV:    { bass: 7,  tones: [7, 11, 2, 6], ext: [9, 1], avoid: [0] },       // Gmaj7#11 flavour
      iv:    { bass: 7,  tones: [7, 10, 2], ext: [9, 5], avoid: [11] },         // borrowed minor iv: G Bb D
      vi:    { bass: 11, tones: [11, 2, 6, 9], ext: [1, 4], avoid: [0] },       // Bm7
      iii:   { bass: 6,  tones: [6, 9, 1, 4], ext: [11], avoid: [7] },          // F#m7
      bVI:   { bass: 10, tones: [10, 2, 5, 9], ext: [0], avoid: [11] },         // Bbmaj7 (modal interchange)
      Vsus:  { bass: 9,  tones: [9, 2, 4, 7], ext: [11], avoid: [1] },          // A9sus4: unresolved, open
    },
    graph: {
      I:     { II: 3, IV: 3, vi: 2, iii: 1, Iadd9: 1, I3: 1.5, bVI: 0.6 },
      Iadd9: { II: 2, IV: 2, vi: 2, I3: 1 },
      I3:    { IV: 3, ii9: 2, vi: 1 },
      II:    { I: 2, IV: 1.5, vi: 1.5, iv: 0.8, Vsus: 1 },
      ii9:   { Vsus: 2, IV: 1.5, I3: 1 },
      IV:    { I: 2, iv: 1.2, vi: 1.5, iii: 1, Vsus: 1, II: 1 },
      iv:    { I: 3, Iadd9: 1, I3: 1 },
      vi:    { IV: 2.5, ii9: 1.5, iii: 1, II: 1, bVI: 0.7 },
      iii:   { vi: 2, IV: 2, II: 1 },
      bVI:   { I: 2, iv: 1, Vsus: 1 },
      Vsus:  { I: 2, vi: 1.5, IV: 1, bVI: 0.6 },
    },
    endings: { question: ["IV", "II", "Vsus", "ii9", "bVI", "vi"], answer: ["I", "Iadd9", "I3", "vi", "iv"] },
    pedalOk: ["I", "Iadd9", "IV", "vi"],
    // Identity motif: a rising fifth that falls back by step, ending open on the second degree.
    motif: [[2, 1], [9, 2], [7, 1], [4, 1.5], [2, 2.5]],
    chapters: [
      ["alone", "bloom", "song", "drift", "settle", "silence"],
      ["drift", "song", "bloom", "lift", "settle", "silence"],
      ["alone", "song", "drift", "bloom", "silence"],
      ["bloom", "song", "lift", "drift", "alone", "silence"],
    ],
    siblings: { alone: ["drift"], bloom: ["song"], settle: ["alone"] },
    sections: {
      alone: { phrases: [2, 3], chords: 2, barsPerChord: 2, level: 0.25, motif: true, motifChance: 0.45, motifForms: ["plain", "fragment", "echo"], breath: [0.8, 2.2], after: 0.6,
        write(c) {   // piano alone, a few notes, lots of space
          const { L, m, at, beat, timeline } = c;
          timeline.forEach((seg) => {
            const b = nearestIn(m.key + seg.ch.bass, 43, 55);
            piano(L, b, at + seg.t0, 0.28 + 0.08 * c.intensity, { dur: seg.t1 - seg.t0 + 0.3, r: 0.9 });
            if (R() < 0.8) piano(L, b + 7 + (R() < 0.4 ? 9 : 0), at + seg.t0 + beat * (1 + Math.floor(R() * 2)), 0.24, { dur: (seg.t1 - seg.t0) * 0.7, r: 1 });
            // second bar of each chord: a soft dyad keeps the air moving (third and seventh, or fifth and ninth)
            const dy = (R() < 0.5 ? [seg.ch.tones[1], seg.ch.tones[3] != null ? seg.ch.tones[3] : seg.ch.tones[2]] : [seg.ch.tones[2], seg.ch.ext[0]]).filter((x) => x != null);
            const t2 = at + seg.t0 + c.bar + beat * (R() < 0.5 ? 0 : 0.5);
            if (t2 < at + seg.t1 - beat) dy.forEach((x, i) => piano(L, nearestIn(m.key + x, 60, 74), t2 + i * 0.05, 0.2, { dur: beat * 3.5, r: 1.2 }));
          });
          if (c.line) playLine(c, fitLine(c.line, timeline, m, [66, 86], beat), "piano", { vel: 0.52, late: beat * (R() < 0.5 ? 0 : 1) });
        } },
      bloom: { phrases: [2, 3], chords: 4, barsPerChord: 1, level: 0.38, motif: true, motifChance: 0.3, motifForms: ["fragment", "seqUp", "invert"], breath: [0.5, 2],
        write(c) {   // slow piano arpeggios, cellos and violas enter underneath
          const { L, m, at, beat, timeline } = c;
          const pat = pick([[0, 1, 2, 1], [0, 2, 1, 2], [0, 1, 2, 3]]);
          timeline.forEach((seg) => {
            const b = nearestIn(m.key + seg.ch.bass, 43, 55);
            piano(L, b, at + seg.t0, 0.3, { dur: seg.t1 - seg.t0 + 0.4, r: 1 });
            const rh = voiceUpper(L.sc.rhPrev, seg.ch.tones.concat(seg.ch.ext.slice(0, 1)).map((x) => pc(m.key + x)), 57, 74, 4);
            L.sc.rhPrev = rh;
            const n = Math.round((seg.t1 - seg.t0) / beat);
            for (let k = 1; k < n * 2; k += 2) {   // off-beat eighths from beat 1.5 keep it flowing but light
              if (R() < 0.15) continue;
              piano(L, rh[pat[(k >> 1) % pat.length] % rh.length], at + seg.t0 + k * beat / 2 + (R() - 0.5) * 0.015, 0.18 + 0.12 * c.intensity, { dur: beat * 1.6, r: 0.9 });
            }
          });
          stringPad(c, R() < 0.5 ? ["vcs", "vlas"] : ["vlas", "vlns"], { stagger: true, gain: 0.11, gainBass: 0.11, lo: 55, hi: 74 });
          if (c.line) playLine(c, fitLine(c.line, timeline, m, [69, 88], beat), "piano", { vel: 0.5 });
        } },
      song: { phrases: [2, 3], chords: 4, barsPerChord: 1, level: 0.48, motif: true, motifChance: 0.45, motifForms: ["plain", "ornament", "seqUp", "seqDown", "invert"], breath: [0, 1.2], lastEnding: "answer",
        write(c) {   // the motif on piano over the full string trio, with broken-chord left hand
          const { L, m, at, beat, timeline } = c;
          timeline.forEach((seg) => {
            const b = nearestIn(m.key + seg.ch.bass, 43, 55);
            const n = Math.round((seg.t1 - seg.t0) / beat);
            piano(L, b, at + seg.t0, 0.34, { dur: seg.t1 - seg.t0 + 0.3, r: 1 });
            const fifth = b + 7, tenth = b + (seg.ch.tones.includes(pc(seg.ch.bass + 4)) ? 16 : 15);
            if (n >= 3) { piano(L, fifth, at + seg.t0 + beat, 0.2, { dur: beat * 2.5 }); piano(L, tenth, at + seg.t0 + beat * 2, 0.2, { dur: beat * 2 }); }
          });
          stringPad(c, ["vcs", "vlas", "vlns"], { stagger: R() < 0.5, gain: 0.1, gainBass: 0.11, lo: 55, hi: 76, ext: R() < 0.5, grow: c.ending === "question" });
          if (c.line) playLine(c, fitLine(c.line, timeline, m, [69, 88], beat), "piano", { vel: 0.58 });
          else if (R() < 0.4) {   // no tune this time: the cellos answer with the motif turned upside down, slowly
            const cl = transform(transform(m.motif, "invert", m.scale), "augment", m.scale).slice(0, 3);
            playLine(c, fitLine(cl, timeline, m, [50, 64], beat), "vcs", { vel: 0.45, gain: 0.17, pan: 0.32, a: 0.5, overlap: 0.3, late: beat });
          }
          if (R() < 0.15) { const ch = timeline[timeline.length - 1].ch; note(L, "harp2", m.key + 24 + pick(ch.tones), at + c.total - beat, { gain: 0.12, pan: -0.55 }); }
        } },
      drift: { phrases: [2, 3], chords: 3, barsPerChord: 2, level: 0.32, motif: false, breath: [0.6, 2],
        write(c) {   // harmony wandering through borrowed colours; no tune, just slowly changing light
          const { L, m, at, beat, timeline } = c;
          stringPad(c, R() < 0.5 ? ["vcs", "vlas", "vlns"] : ["vlas", "vlns"], { stagger: true, gain: 0.11, gainBass: 0.1, lo: 57, hi: 79, ext: true });
          timeline.forEach((seg) => {
            if (R() < 0.6) {
              const tones = seg.ch.tones.concat(seg.ch.ext).map((x) => m.key + 12 + x).filter((x) => x > 70 && x < 90);
              const t0 = at + seg.t0 + beat * (1 + Math.floor(R() * 4));
              [pick(tones), pick(tones)].forEach((x, i) => piano(L, x, t0 + i * beat * 1.5, 0.22 + 0.06 * c.intensity, { dur: beat * 3, r: 1.4 }));
            }
          });
          if (R() < 0.35) note(L, "harp2", m.key + 12 + pick(timeline[0].ch.tones), at + beat * 2, { gain: 0.1, pan: -0.5 });
        } },
      lift: { phrases: [1, 1], chords: 4, barsPerChord: 2, level: 0.66, motif: true, motifForms: ["plain", "seqUp"], breath: [1, 2], tempo: 0.96, after: 2,
        write(c) {   // the one emotional moment: the motif, augmented, on solo violin over the full strings
          const { L, m, at, beat, timeline } = c;
          stringPad(c, ["vcs", "vlas", "vlns"], { gain: 0.12, gainBass: 0.12, lo: 55, hi: 76, ext: true, grow: true });
          timeline.forEach((seg) => {
            const b = nearestIn(m.key + seg.ch.bass, 43, 55);
            piano(L, b, at + seg.t0, 0.32, { dur: seg.t1 - seg.t0, r: 1.2 });
            const rh = voiceUpper(L.sc.rhPrev, seg.ch.tones.map((x) => pc(m.key + x)), 60, 76, 3);
            L.sc.rhPrev = rh;
            rh.forEach((x, i) => piano(L, x, at + seg.t0 + beat * 2 + i * 0.06, 0.24, { dur: beat * 5 }));
          });
          if (c.line) playLine(c, fitLine(c.line, timeline, m, [67, 91], beat), "solovln", { vel: 0.62, gain: 0.32, pan: 0.05, a: 0.4, overlap: 0.25 });
        } },
      settle: { phrases: [1, 2], chords: 2, barsPerChord: 2, level: 0.26, motif: true, motifChance: 0.8, motifForms: ["fragment", "echo"], breath: [0.8, 2], lastEnding: "answer",
        write(c) {   // memory of the theme, high and quiet, over a held chord
          const { L, m, at, beat, timeline } = c;
          stringPad(c, ["vlas", "vlns"], { gain: 0.09, lo: 60, hi: 79 });
          timeline.forEach((seg) => piano(L, nearestIn(m.key + seg.ch.bass, 43, 55), at + seg.t0, 0.2, { dur: seg.t1 - seg.t0 + 0.8, r: 1.5 }));
          if (c.line) playLine(c, fitLine(c.line, timeline, m, [74, 93], beat), "piano", { vel: 0.4 });
        } },
      silence: { phrases: [1, 1], chords: 1, barsPerChord: 2, level: 0.15, motif: false, pedalOnly: true, breath: [0.5, 1.5],
        write(c) {   // near silence: one low note under a faint high fifth in the violins, a distant harmonic
          const { L, m, at, beat } = c;
          piano(L, m.key - 12, at, 0.14, { dur: beat * 7, r: 2 });
          bowed(L, "vlns", m.key + 21, at + beat, beat * 8, { gain: 0.07, d0: 0.08, d1: 0.05, swell: 0.08, a: 2, r: 2.5, pan: -0.3 });
          if (R() < 0.5) note(L, "harp2", m.key + 21 + pick([0, 4, 7]), at + beat * 3, { gain: 0.07, pan: 0.5 });
        } },
    },
  };
  dreamy.bed = (c, len) => {
    const ch = c.timeline[0].ch, x = nearestIn(c.m.key + ch.tones[2], 57, 69);
    bowed(c.L, "vlas", x, c.at + 0.3, len + 0.5, { gain: 0.06, d0: 0.08, d1: 0.06, swell: 0.1, a: 2.5, r: 2.5, pan: 0.2 });
  };
  ["alone", "settle"].forEach((k) => (dreamy.sections[k].bed = true));
  dreamy.step = makeStep(dreamy);
  dreamy.start = eqStart(dreamy);

  /* ======================================================================
     NOIR — piano, double bass, muted trumpet, brushes; low clarinet as a second voice.
     D minor with Phrygian and Dorian shadows; tension that often does not resolve.
     ====================================================================== */
  const noir = {
    name: "Noir", line: "Paris, 3 a.m. Wet cobblestones and a muted trumpet somewhere.",
    colors: ["#c9b38a", "#7d6a52", "#1a1714"],
    uses: ["piano2_pp", "piano2_mp", "piano2_mf", "dbpizz_p", "dbpizz_f", "dbarco"].concat(layersOf(["mutetpt", "clar2"])),
    bpm: 58, beats: 4, key: 62, wet: 0.55, dry: 0.86, level: 1.56, swing: 0.62,
    eq: { low: -2, lowF: 120, mid: -1.5, midF: 300, high: 2, highF: 5000 },
    scale: [0, 2, 3, 5, 7, 9, 10],      // D Dorian as the default colour; chords borrow b2, b6, #7
    home: "i",
    chords: {
      i:     { bass: 0, tones: [0, 3, 7, 10], ext: [2, 5], avoid: [8, 1] },        // Dm9
      imaj:  { bass: 0, tones: [0, 3, 7, 11], ext: [2], avoid: [10, 8] },          // Dm(maj9): the noir chord
      iv:    { bass: 7, tones: [7, 10, 2, 5], ext: [9, 0], avoid: [8] },           // Gm9
      bVI:   { bass: 10, tones: [10, 2, 5, 9], ext: [0, 4], avoid: [11] },         // Bbmaj7(#11)
      bII:   { bass: 3, tones: [3, 7, 10, 2], ext: [9], avoid: [4] },              // Ebmaj7: Phrygian shadow
      ii_hd:   { bass: 4, tones: [4, 7, 10, 2], ext: [5], avoid: [3] },              // Em7b5
      V7b9:  { bass: 9, tones: [9, 1, 4, 7], ext: [10, 5], avoid: [2] },           // A7(b9 b13)
      bVII:  { bass: 0, tones: [0, 4, 7, 10], ext: [2], avoid: [5] },              // C7 over C... (C9)
      ped:   { bass: 0, tones: [3, 7, 10, 2], ext: [5], avoid: [8] },              // minor pedal
      pedb2: { bass: 0, tones: [3, 7, 10, 1], ext: [5], avoid: [2] },              // Eb triad over D pedal: unsettled
    },
    graph: {
      i:     { iv: 2.5, bVI: 2, ii_hd: 1.5, imaj: 1, bII: 1, ped: 0.6 },
      imaj:  { i: 1.5, iv: 2, bVI: 1.5 },
      iv:    { bVI: 1.5, ii_hd: 1.5, V7b9: 1.5, i: 1.2, bVII: 1 },
      bVI:   { ii_hd: 2, V7b9: 1.5, bII: 1.2, iv: 1 },
      bII:   { i: 2, V7b9: 1, imaj: 1 },
      ii_hd:   { V7b9: 3.5, bII: 0.6 },
      V7b9:  { i: 2.5, imaj: 1.5, bVI: 1.5, pedb2: 0.6 },
      bVII:  { bVI: 2, iv: 1, i: 1 },
      ped:   { pedb2: 2.5, i: 1 },
      pedb2: { ped: 2, i: 1.5 },
    },
    endings: { question: ["V7b9", "bII", "ii_hd", "pedb2", "iv"], answer: ["i", "imaj", "bVI"] },
    pedalOk: ["i", "ped", "imaj"],
    // Identity motif: a semitone sigh on the sixth, then a fall to the second degree.
    motif: [[7, 1.5], [8, 0.5], [7, 1], [3, 1], [2, 3]],
    chapters: [
      ["fog", "street", "trumpet", "piano", "fog", "empty"],
      ["piano", "trumpet", "clarinet", "street", "empty"],
      ["fog", "trumpet", "street", "lift", "piano", "empty"],
      ["street", "clarinet", "trumpet", "fog", "empty"],
    ],
    siblings: { piano: ["fog"], clarinet: ["piano"], street: ["trumpet"] },
    sections: {
      fog: { phrases: [1, 2], chords: 2, barsPerChord: 2, level: 0.25, pedalOnly: false, motif: false, breath: [0.8, 2],
        write(c) {   // bowed bass pedal, piano clusters far away, a few brush circles
          const { L, m, at, beat, bar, timeline } = c;
          const ped = nearestIn(m.key + timeline[0].ch.bass, 28, 40);
          bowed(L, "dbarco", ped, at, c.total + 0.4, { gain: 0.2, d0: 0.25, d1: 0.35, swell: 0.15, a: 1.4, r: 2, pan: 0.15 });
          timeline.forEach((seg) => {
            const v = voiceUpper(L.sc.rhPrev, seg.ch.tones.concat(seg.ch.ext.slice(0, 1)).map((x) => pc(m.key + x)), 55, 72, 4);
            L.sc.rhPrev = v;
            const t0 = at + seg.t0 + beat * (R() < 0.5 ? 0.5 : 2.5);
            v.forEach((x, i) => piano(L, x, t0 + i * 0.03, 0.15 + 0.05 * c.intensity, { dur: beat * 3.5, r: 1.6, lp: 3500 }));
          });
          if (R() < 0.5) for (let b = 0; b < c.total / bar - 0.01; b++) brushBar(L, at + b * bar, beat, 0.22, false);
        } },
      street: { phrases: [2, 3], chords: 4, barsPerChord: 1, level: 0.42, motif: false, breath: [0, 1.5],
        write(c) {   // the band: walking (or two-feel) bass, brushes, sparse rootless comping
          const { L, m, at, beat, bar, timeline } = c;
          const walk = c.intensity > 0.38 && R() < 0.65;
          timeline.forEach((seg, i) => {
            const next = timeline[i + 1] ? timeline[i + 1].ch : m.chords[m.home];
            bassBar(c, seg, next, walk);
            brushBar(L, at + seg.t0, beat, 0.5 + 0.3 * c.intensity, true);
            comp(c, seg);
          });
          if (R() < 0.4) answerLick(c);
          else if (R() < 0.25) {   // a low clarinet remembers two notes of the tune
            const fr = transform(m.motif, "fragment", m.scale);
            playLine(c, fitLine(fr, timeline, m, [52, 66], beat), "clar2", { vel: 0.35, gain: 0.2, pan: -0.28, late: beat * 2, a: 0.2 });
          }
        } },
      trumpet: { phrases: [1, 2], chords: 4, barsPerChord: 1, level: 0.45, motif: true, motifChance: 0.75, motifForms: ["plain", "ornament", "seqDown", "invert", "fragment"], breath: [0.5, 2], lastEnding: "answer",
        write(c) {   // the muted trumpet carries the motif; the band plays less around it
          const { L, m, at, beat, timeline } = c;
          timeline.forEach((seg, i) => {
            const next = timeline[i + 1] ? timeline[i + 1].ch : m.chords[m.home];
            bassBar(c, seg, next, false);
            if (R() < 0.7) brushBar(L, at + seg.t0, beat, 0.4, true);
            if (R() < 0.55) comp(c, seg, 0.8);
          });
          if (c.line) playLine(c, swingLine(c, fitLine(c.line, timeline, m, [60, 79], beat)), "mutetpt", { vel: 0.5, gain: 0.32, pan: 0.22, fall: 0.35, overlap: 0.02, cutoff: 4200, dynCap: 0.7 });
        } },
      clarinet: { phrases: [1, 2], chords: 3, barsPerChord: 2, level: 0.34, motif: true, motifChance: 0.8, motifForms: ["invert", "seqDown", "fragment"], breath: [1, 2.5],
        write(c) {   // low clarinet answers in the chalumeau register; piano and bowed bass only
          const { L, m, at, beat, timeline } = c;
          timeline.forEach((seg) => {
            const b = nearestIn(m.key + seg.ch.bass, 28, 40);
            note(L, "dbpizz_p", b, at + seg.t0, { gain: 0.36, pan: 0.15 });
            if (R() < 0.6) note(L, "dbpizz_p", b + 7, at + seg.t0 + beat * 2, { gain: 0.26, pan: 0.15 });
            comp(c, seg, 0.7);
          });
          if (c.line) playLine(c, fitLine(transform(c.line, "augment", m.scale), timeline, m, [52, 70], beat), "clar2", { vel: 0.45, gain: 0.26, pan: -0.25, a: 0.25 });
        } },
      piano: { phrases: [2, 2], chords: 2, barsPerChord: 2, level: 0.3, motif: true, motifChance: 0.6, motifForms: ["fragment", "plain", "echo"], breath: [0.6, 2],
        write(c) {   // solo piano, rubato, the motif in the right hand, a chord now and then
          const { L, m, at, beat, timeline } = c;
          if (R() < 0.5) bowed(L, "dbarco", nearestIn(m.key + timeline[0].ch.bass, 28, 40), at, c.total + 0.3, { gain: 0.13, d0: 0.2, d1: 0.25, swell: 0.1, a: 1.5, r: 2, pan: 0.12 });
          timeline.forEach((seg) => {
            piano(L, nearestIn(m.key + seg.ch.bass, 36, 48), at + seg.t0, 0.28, { dur: seg.t1 - seg.t0 + 0.5, r: 1.2 });
            comp(c, seg, 0.9, true);
            comp(Object.assign({}, c, { at: at + c.bar }), seg, 0.5, true);
          });
          if (c.line) playLine(c, swingLine(c, fitLine(c.line, timeline, m, [65, 84], beat)), "piano", { vel: 0.4 });
        } },
      lift: { phrases: [1, 1], chords: 4, barsPerChord: 2, level: 0.55, motif: true, motifForms: ["plain"], breath: [1, 2], tempo: 0.95, after: 1.5,
        write(c) {   // the late-night moment: trumpet, long tones, bowed bass and a darker harmony
          const { L, m, at, beat, timeline } = c;
          timeline.forEach((seg) => {
            bowed(L, "dbarco", nearestIn(m.key + seg.ch.bass, 28, 40), at + seg.t0, seg.t1 - seg.t0 + 0.3, { gain: 0.2, d0: 0.35, d1: 0.5, swell: 0.15, a: 0.8, r: 1.5, pan: 0.15 });
            comp(c, seg, 0.9, true);
            brushBar(L, at + seg.t0, beat, 0.3, false);
          });
          if (c.line) playLine(c, fitLine(c.line, timeline, m, [62, 81], beat), "mutetpt", { vel: 0.62, gain: 0.34, pan: 0.2, fall: 0.6, a: 0.12, cutoff: 4500, dynCap: 0.8 });
        } },
      empty: { phrases: [1, 1], chords: 1, barsPerChord: 2, level: 0.15, motif: false, pedalOnly: true, breath: [0.5, 1.5],
        write(c) {   // the street is empty: one bass note, a bowed low D far away, one distant piano tone
          const { L, m, at, beat } = c;
          bowed(L, "dbarco", m.key - 24, at + 0.2, beat * 8, { gain: 0.15, d0: 0.15, d1: 0.1, swell: 0.1, a: 1.5, r: 2.5, pan: 0.1 });
          note(L, "dbpizz_p", m.key - 24, at, { gain: 0.32, pan: 0.12 });
          if (R() < 0.7) piano(L, m.key + pick([8, 13, 15]), at + beat * (2 + R() * 2), 0.12, { dur: beat * 4, r: 2, lp: 3000 });
        } },
    },
  };
  // swing: push off-beat eighths late, like a player would
  function swingLine(c, notes) {
    if (!notes) return notes;
    const sw = (c.m.swing - 0.5) * 2 * 0.5;   // fraction of an eighth
    return notes.map((n) => (Math.abs(n.at * 2 - Math.round(n.at * 2)) < 0.01 && Math.round(n.at * 2) % 2 === 1 ? Object.assign({}, n, { at: n.at + sw * 0.5 }) : n));
  }
  function bassBar(c, seg, next, walk) {
    const { L, m, at, beat } = c;
    const root = nearestIn(m.key + seg.ch.bass, 28, 40, L.sc.bassPrev);
    L.sc.bassPrev = root;
    const vel = 0.32 + 0.18 * c.intensity, sw = (m.swing - 0.5) * beat * 0.5;
    if (!walk) {   // two-feel: root, then fifth or a chromatic approach to the next chord
      note(L, "dbpizz_p", root, at + seg.t0, { gain: vel + 0.05, pan: 0.15 });
      const tgt = nearestIn(m.key + next.bass, 28, 40, root);
      const second = R() < 0.5 ? root + 7 : tgt + (tgt > root ? -1 : 1);
      note(L, "dbpizz_p", second, at + seg.t0 + beat * 2 + (R() < 0.3 ? sw : 0), { gain: vel, pan: 0.15 });
      return;
    }
    const tones = seg.ch.tones.map((x) => pc(m.key + x));
    const tgt = nearestIn(m.key + next.bass, 28, 40, root);
    const line = [root];
    for (let b = 1; b < 3; b++) {
      const prev = line[b - 1];
      const cands = [];
      for (let x = prev - 4; x <= prev + 5; x++) if (x !== prev && x >= 28 && x <= 45 && (tones.includes(pc(x)) || m.scale.includes(pc(x - m.key)))) cands.push(x);
      cands.sort((p, q) => Math.abs(p - tgt) - Math.abs(q - tgt) + (R() - 0.5) * 4);
      line.push(cands[0] || prev + 2);
    }
    line.push(tgt + (tgt > line[2] ? -1 : 1));   // chromatic approach into the next bar
    line.forEach((x, b) => note(L, "dbpizz_p", x, at + seg.t0 + b * beat + (R() - 0.5) * 0.012, { gain: vel * (b ? 0.9 : 1.05), pan: 0.15 }));
  }
  // Rootless voicings, placed sparsely: on 1, the "and" of 2, or anticipating the next bar.
  function comp(c, seg, prob = 1, solo) {
    const { L, m, at, beat } = c;
    if (R() > prob) return;
    const pcs = seg.ch.tones.slice(1).concat(seg.ch.ext.slice(0, 1)).map((x) => pc(m.key + x));
    const v = voiceUpper(L.sc.compPrev, pcs, solo ? 55 : 53, 70, solo ? 4 : 3);
    L.sc.compPrev = v;
    const sw = (m.swing - 0.5) * beat * 0.5;
    const spots = pick([[0], [1.5], [0, 2.5], [3.5], [1.5, 3]]);
    spots.forEach((s) => {
      const t = at + seg.t0 + s * beat + (s % 1 ? sw : 0);
      const vel = 0.16 + 0.12 * c.intensity + (s === 0 ? 0.04 : 0);
      v.forEach((x, i) => piano(L, x, t + i * 0.012, vel, { dur: beat * (s % 1 ? 0.9 : 1.8), r: 0.5 }));
    });
  }
  // A short right-hand answer in the cracks of the band (blue third, b5 passing).
  function answerLick(c) {
    const { L, m, at, beat } = c;
    const notes = pick([[10, 7, 5, 3], [3, 5, 6, 7], [12, 10, 7, 8, 7]]);
    const t0 = at + c.total - beat * 2.5;
    notes.forEach((x, i) => piano(L, m.key + 12 + x, t0 + i * beat * 0.5 + (i % 2 ? (m.swing - 0.5) * beat * 0.5 : 0), 0.2, { dur: beat * 0.6, r: 0.4 }));
  }
  noir.bed = (c, len) => {
    bowed(c.L, "dbarco", nearestIn(c.m.key + c.timeline[0].ch.bass, 28, 40), c.at + 0.2, len + 0.5, { gain: 0.11, d0: 0.15, d1: 0.12, swell: 0.08, a: 2, r: 2.5, pan: 0.12 });
  };
  ["piano", "clarinet", "trumpet"].forEach((k) => (noir.sections[k].bed = true));
  noir.step = makeStep(noir);
  noir.start = eqStart(noir);

  E.MOODS.dreamy = dreamy;
  E.MOODS.noir = noir;
})(typeof window !== "undefined" ? window : globalThis);
