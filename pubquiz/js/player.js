/* player.js: het scherm van iedere deelnemer */
(function () {
  'use strict';

  const $ = (s, el) => (el || document).querySelector(s);
  const esc = QZ.esc;
  const app = $('#app');
  const params = new URLSearchParams(location.search);

  const DEFAULT_CODE = clean(QZ.DEFAULT_CODE || '');
  let code = clean(params.get('c') || params.get('code') || '');
  let myName = '';
  let game = null;
  let connected = true;
  let unsub = null;
  let lastKey = '';
  let lastPhase = '';
  let lastScreen = '';
  let confettiDone = false;
  let inflight = false;
  let wakeLock = null;

  function clean(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); }
  const joinKey = () => 'pubquiz-join:' + Store.uid;
  const PENDING = 'pubquiz-pending';

  let pending = null; // { code, qkey, payload, status: 'sending' | 'rejected' }
  try { pending = JSON.parse(localStorage.getItem(PENDING) || 'null'); } catch (e) { pending = null; }
  function savePending() {
    if (pending) localStorage.setItem(PENDING, JSON.stringify(pending));
    else localStorage.removeItem(PENDING);
  }

  /* ---------------- opstart ---------------- */
  async function boot() {
    QZ.registerSW();
    app.innerHTML = shell('<div class="card center"><p class="pulse">Verbinden…</p></div>');
    try {
      await Store.init();
    } catch (e) {
      console.error(e);
      app.innerHTML = shell('<div class="banner err">Kan geen verbinding maken met de quizserver. Check je internet en ververs de pagina.</div>');
      return;
    }
    Store.onConnection((c) => { connected = c; updateConn(); if (c) resend(); });

    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(joinKey()) || 'null'); } catch (e) { saved = null; }
    if (saved && saved.code && saved.name && (!code || saved.code === code)) {
      code = saved.code;
      myName = saved.name;
      startSession(true);
    } else {
      if (!code) code = DEFAULT_CODE;
      showJoin();
    }
    requestAnimationFrame(tick);
  }

  function shell(inner, animate) {
    const title = (game && game.meta && game.meta.title) || 'Pubquiz';
    const b = game ? QZ.board(game) : [];
    const mine = b.find((r) => r.id === Store.uid);
    return '<div class="wrap">' +
      '<header class="top"><div class="brand"><img class="logo" src="favicon.svg" alt=""><span>' + esc(title) + '</span></div>' +
      '<div class="spacer"></div>' +
      (mine ? '<span class="pill" title="Jouw score">' + mine.score + ' pt · ' + mine.rank + 'e</span>' : '') +
      '<span class="pill" id="conn" title="Verbinding"><i class="dot ' + (connected ? 'on' : 'off') + '"></i>' + (connected ? '' : 'offline') + '</span>' +
      '</header>' +
      (Store.isDemo ? '<div class="banner">Demo-modus: werkt alleen tussen tabbladen op dit apparaat. Vul eerst <b>firebase-config.js</b> in voor de echte quiz.</div>' : '') +
      (!connected && game ? '<div class="banner info">Geen verbinding. Je antwoorden worden bewaard en verstuurd zodra je weer online bent.</div>' : '') +
      '<main id="view"' + (animate === false ? '' : ' class="fade-in"') + '>' + inner + '</main></div>';
  }

  function updateConn() {
    if (game) { lastKey = ''; render(); return; }
    // join-scherm niet opnieuw opbouwen (ingetypte naam blijft staan): alleen het lampje bijwerken
    const pill = $('#conn');
    if (pill) pill.innerHTML = '<i class="dot ' + (connected ? 'on' : 'off') + '"></i>' + (connected ? '' : 'offline');
  }

  /* ---------------- meedoen ---------------- */
  function showJoin(error) {
    lastKey = 'join';
    app.innerHTML = shell(
      '<div class="card">' +
      '<div class="big-emoji center">🚆</div>' +
      '<h1 class="center">Doe mee met de pubquiz</h1>' +
      (error ? '<div class="banner err">' + esc(error) + '</div>' : '') +
      '<form id="joinForm" autocomplete="off">' +
      '<label for="code">Spelcode</label>' +
      '<input id="code" class="code" type="text" maxlength="8" value="' + esc(code) + '" placeholder="BONN" required>' +
      '<label for="name">Je naam</label>' +
      '<input id="name" type="text" maxlength="24" value="' + esc(myName) + '" placeholder="Voornaam" required>' +
      '<button class="btn primary block" type="submit">Doe mee ▶</button>' +
      '</form>' +
      '<p class="muted small center" style="margin-top:14px">Tip: laat dit scherm open staan tijdens de quiz.</p>' +
      '</div>');
    const form = $('#joinForm');
    if (code) $('#name').focus(); else $('#code').focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const c = clean($('#code').value);
      const n = $('#name').value.trim().slice(0, 24);
      if (!c || !n) return;
      const btn = form.querySelector('button');
      btn.disabled = true; btn.textContent = 'Even zoeken…';
      let host = null;
      try {
        host = await withTimeout(Store.hostOf(c), 12000);
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Doe mee ▶';
        return showJoin('Geen verbinding met de quizserver. Probeer het zo nog eens.');
      }
      if (!host) {
        code = c; myName = n;
        return showJoin('Geen spel gevonden met code ' + c + '. Klopt de code?');
      }
      code = c; myName = n;
      requestWakeLock();
      startSession(false);
    });
  }

  function withTimeout(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  }

  function startSession(silent) {
    localStorage.setItem(joinKey(), JSON.stringify({ code, name: myName }));
    const q = new URLSearchParams(location.search);
    q.set('c', code);
    history.replaceState(null, '', '?' + q.toString());
    Store.join(code, myName).catch((e) => {
      console.warn('join', e);
      if (!silent) showJoin('Meedoen lukte niet. Probeer het opnieuw.');
    });
    if (unsub) unsub();
    unsub = Store.subscribe(code, onGame);
    if (silent) app.innerHTML = shell('<div class="card center"><p class="pulse">Terug naar het spel…</p></div>');
  }

  function leave() {
    if (unsub) unsub();
    unsub = null;
    game = null;
    localStorage.removeItem(joinKey());
    showJoin();
  }

  function onGame(g) {
    if (!g) {
      game = null;
      localStorage.removeItem(joinKey());
      return showJoin('Dit spel bestaat niet (meer). Vraag de quizmaster om de juiste link.');
    }
    game = g;
    if (g.players && g.players[Store.uid] && g.players[Store.uid].name) myName = g.players[Store.uid].name;
    const st = g.state || {};
    if (pending && (pending.code !== code || (st.qkey !== pending.qkey && st.phase === 'question'))) {
      pending = null; savePending();
    }
    // alleen opruimen als er geen verzending loopt: tijdens het versturen toont Firebase het antwoord al lokaal
    if (pending && !inflight && serverAnswer(pending.qkey)) { pending = null; savePending(); }
    resend();
    if (st.phase !== lastPhase && st.phase === 'question' && navigator.vibrate) navigator.vibrate(60);
    lastPhase = st.phase;
    render();
  }

  /* ---------------- antwoorden ---------------- */
  function serverAnswer(qkey) {
    return game && game.answers && game.answers[qkey] && game.answers[qkey][Store.uid];
  }
  function myAnswer(qkey) {
    return serverAnswer(qkey) || (pending && pending.qkey === qkey ? pending.payload : null);
  }

  function answer(value) {
    const st = game && game.state;
    if (!st || st.phase !== 'question' || myAnswer(st.qkey)) return;
    const now = Store.now();
    if (now > st.deadline) { toast('Te laat! ⏰'); return; }
    pending = { code, qkey: st.qkey, payload: { a: value, ms: Math.max(0, Math.round(now - st.startedAt)) }, status: 'sending' };
    savePending();
    if (navigator.vibrate) navigator.vibrate(25);
    render();
    send();
  }

  async function send() {
    if (!pending || inflight) return;
    inflight = true;
    const p = pending;
    const r = await Store.submitAnswer(p.code, p.qkey, p.payload);
    inflight = false;
    if (pending !== p) return;
    if (r === 'ok' || serverAnswer(p.qkey)) { pending = null; }
    else { pending.status = 'rejected'; }
    savePending();
    render();
  }

  function resend() {
    if (!pending || !game || !connected || inflight) return;
    const st = game.state || {};
    if (pending.status === 'rejected') return;
    if (st.phase === 'question' && st.qkey === pending.qkey && !serverAnswer(pending.qkey)) send();
  }

  /* ---------------- weergave ---------------- */
  function viewKey() {
    if (!game) return 'none';
    const st = game.state || {};
    const a = st.qkey ? myAnswer(st.qkey) : null;
    const nPlayers = Object.keys(game.players || {}).length;
    const res = JSON.stringify((game.results && st.qkey && game.results[st.qkey]) || null);
    const timeUp = st.phase === 'question' && Store.now() > st.deadline;
    const extra = (st.phase === 'lobby' || st.phase === 'scores' || st.phase === 'final' || st.phase === 'reveal')
      ? JSON.stringify(QZ.board(game).map((r) => r.id + r.score + r.name)) : '';
    const ansCount = st.phase === 'reveal' ? Object.keys((game.answers && game.answers[st.qkey]) || {}).length : 0;
    return [st.phase, st.idx, st.qkey, JSON.stringify(a), pending && pending.status, nPlayers, res, timeUp, extra, ansCount, connected, myName].join('|');
  }

  function render() {
    if (!game) return;
    const key = viewKey();
    if (key === lastKey) return;
    lastKey = key;
    const st = game.state || { phase: 'lobby' };
    let html = '';
    switch (st.phase) {
      case 'lobby': html = viewLobby(); break;
      case 'intro': html = viewIntro(st); break;
      case 'question': html = viewQuestion(st); break;
      case 'closing': html = '<div class="card center"><div class="big-emoji">⏰</div><h2>Tijd is om!</h2><p class="muted pulse">Even rekenen…</p></div>'; break;
      case 'reveal': html = viewReveal(st); break;
      case 'scores': html = viewScores(st); break;
      case 'final': html = viewFinal(); break;
      default: html = viewLobby();
    }
    // bewaar ingetypte schatting bij herrenderen
    const est = $('#estimate');
    const estVal = est ? est.value : null;
    const screen = st.phase + '|' + st.idx;
    app.innerHTML = shell(html, screen !== lastScreen);
    lastScreen = screen;
    if (estVal !== null && $('#estimate')) $('#estimate').value = estVal;
    bind(st);
    if (st.phase === 'final' && !confettiDone) { confettiDone = true; QZ.confetti(); }
  }

  function viewLobby() {
    const players = game.players || {};
    const ids = Object.keys(players).sort((a, b) => (players[a].joinedAt || 0) - (players[b].joinedAt || 0));
    return '<div class="card center">' +
      '<div class="big-emoji">🎉</div>' +
      '<h2>Hoi ' + esc(myName) + ', je doet mee!</h2>' +
      '<p class="muted">Wacht tot de quizmaster begint. Spelcode: <b>' + esc(code) + '</b></p>' +
      '</div>' +
      '<div class="card"><div class="eyebrow" style="margin-bottom:8px">Al binnen (' + ids.length + ')</div><div class="chips">' +
      ids.map((id) => '<span class="chip ' + (id === Store.uid ? 'me' : '') + '"><i class="dot ' + (players[id].online !== false ? 'on' : '') + '"></i>' + esc(players[id].name) + '</span>').join('') +
      '</div></div>' +
      '<div class="row" style="justify-content:center"><button class="btn ghost small" id="rename">Naam wijzigen</button>' +
      '<button class="btn ghost small" id="leave">Ander spel</button></div>';
  }

  function viewIntro(st) {
    const r = st.round || {};
    return '<div class="card center">' +
      '<div class="eyebrow">Ronde ' + (r.no || '') + (r.of ? ' van ' + r.of : '') + '</div>' +
      '<div class="big-emoji">' + esc(r.emoji || '❓') + '</div>' +
      '<h1>' + esc(r.title || '') + '</h1>' +
      '<p class="muted">' + (r.count ? r.count + (r.count === 1 ? ' vraag' : ' vragen') : '') + '</p>' +
      '<p class="muted pulse small">Maak je klaar…</p></div>';
  }

  function qHeader(st) {
    const q = st.q || {};
    const label = q.type === 'vote' ? 'Stemvraag · geen punten' : 'Vraag ' + q.num + ' van ' + q.total;
    return '<div class="eyebrow">' + esc(q.emoji || '') + ' ' + esc(q.cat || '') + ' · ' + label + '</div>' +
      '<div class="qtext">' + esc(q.text) + '</div>';
  }

  function timerHtml() {
    return '<div class="timer" id="tbar"><i></i></div><div class="timer-row"><span id="tleft"></span><span id="tstatus"></span></div>';
  }

  function statusLine(st, a) {
    if (!a) return '';
    if (pending && pending.qkey === st.qkey) {
      if (pending.status === 'rejected') return '<div class="banner err" style="margin-top:12px">Je antwoord kwam niet op tijd binnen. 😕</div>';
      if (!connected) return '<div class="banner info" style="margin-top:12px">⏳ Antwoord bewaard op je telefoon. Het wordt verstuurd zodra er weer verbinding is.</div>';
      return '<p class="center muted" style="margin-top:12px">⏳ Versturen…</p>';
    }
    return '<p class="center" style="margin-top:12px">✅ Antwoord binnen. Wacht op de rest…</p>';
  }

  function viewQuestion(st) {
    const q = st.q || {};
    const a = myAnswer(st.qkey);
    const timeUp = Store.now() > st.deadline;
    const locked = !!a || timeUp;
    let body = '';
    if (q.type === 'mc') {
      body = '<div class="opts">' + (q.options || []).map((o, i) => {
        const cls = ['opt', 'o' + i];
        if (a) cls.push(a.a === i ? 'chosen' : 'dim');
        else if (timeUp) cls.push('dim');
        return '<button class="' + cls.join(' ') + '" data-i="' + i + '"' + (locked ? ' disabled' : '') + '>' +
          '<span class="letter">' + QZ.LETTERS[i] + '</span><span class="label">' + esc(o) + '</span></button>';
      }).join('') + '</div>';
    } else if (q.type === 'vote') {
      const opts = q.options || [];
      body = '<div class="names">' + opts.map((p) =>
        '<button class="name-btn' + (a && a.a === p.id ? ' chosen' : '') + '" data-id="' + esc(p.id) + '"' + (locked ? ' disabled' : '') + '>' +
        esc(p.name) + (p.id === Store.uid ? ' <span class="small">(jij)</span>' : '') + '</button>').join('') + '</div>';
      if (!opts.length) body = '<p class="muted">Geen namen beschikbaar.</p>';
    } else if (q.type === 'estimate') {
      body = a
        ? '<div class="center"><div class="eyebrow">Jouw schatting</div><div class="score-pop">' + QZ.fmt(Number(a.a)) + '</div></div>'
        : '<form id="estForm"><input id="estimate" type="text" inputmode="numeric" placeholder="Jouw schatting' + (q.unit ? ' (' + esc(q.unit) + ')' : '') + '"' + (timeUp ? ' disabled' : '') + '>' +
          '<button class="btn primary block" type="submit"' + (timeUp ? ' disabled' : '') + '>Verstuur schatting</button></form>';
    }
    return '<div class="card">' + qHeader(st) + timerHtml() + body + statusLine(st, a) +
      (timeUp && !a ? '<p class="center muted" style="margin-top:12px">⏰ Tijd is om.</p>' : '') + '</div>';
  }

  function viewReveal(st) {
    const q = st.q || {};
    const a = serverAnswer(st.qkey);
    const pts = (game.results && game.results[st.qkey] && game.results[st.qkey].pts) || {};
    const b = QZ.board(game);
    const mine = b.find((r) => r.id === Store.uid);
    let top = '';
    if (q.type === 'mc') {
      if (!a) top = '<div class="score-pop bad">Geen antwoord</div>';
      else if (a.a === (st.reveal || {}).correct) top = '<div class="score-pop ok">Goed! +' + (pts[Store.uid] || 0) + '</div>';
      else top = '<div class="score-pop bad">Helaas</div>';
    } else if (q.type === 'estimate') {
      if (!a) top = '<div class="score-pop bad">Geen schatting</div>';
      else top = (pts[Store.uid] ? '<div class="score-pop ok">+' + pts[Store.uid] + '</div>' : '') +
        '<p class="muted">Jij zat er ' + QZ.fmt(Math.abs(Number(a.a) - st.reveal.correct)) + ' naast.</p>';
    } else if (q.type === 'vote') {
      top = '<div class="eyebrow">De groep heeft gesproken</div>';
    }
    if (!a && pending && pending.qkey === st.qkey) top += '<p class="muted small">Je antwoord kwam niet op tijd binnen (geen verbinding).</p>';
    return '<div class="card">' + qHeader(st) + '<div class="center">' + top + '</div>' + QZ.revealHtml(game, Store.uid, false) + '</div>' +
      (mine && q.type !== 'vote' ? '<p class="center muted">Je staat <b>' + mine.rank + 'e</b> met <b>' + mine.score + '</b> punten.</p>' : '');
  }

  function viewScores(st) {
    const rows = QZ.board(game);
    const d = QZ.deltas(game, st.keys || []);
    return '<div class="card"><div class="eyebrow">Na ronde ' + esc(st.roundNo || '') + ': ' + esc(st.roundTitle || '') + '</div>' +
      '<h2>Tussenstand</h2>' + QZ.boardHtml(rows, { me: Store.uid, limit: 10, deltas: d }) + '</div>';
  }

  function viewFinal() {
    const rows = QZ.board(game);
    const mine = rows.find((r) => r.id === Store.uid);
    return '<div class="card center"><div class="big-emoji">🏆</div><h1>Eindstand</h1>' +
      (mine ? '<p>Jij bent <b>' + mine.rank + 'e</b> geworden met <b>' + mine.score + '</b> punten.</p>' : '') +
      QZ.podiumHtml(rows) + '</div>' + QZ.speedHtml(game, Store.uid) +
      '<div class="card">' + QZ.boardHtml(rows, { me: Store.uid }) + '</div>' +
      '<p class="center muted">Bedankt voor het meespelen en veel plezier in Bonn! 🎄</p>';
  }

  function bind(st) {
    app.querySelectorAll('.opt[data-i]').forEach((b) => b.addEventListener('click', () => answer(Number(b.dataset.i))));
    app.querySelectorAll('.name-btn[data-id]').forEach((b) => b.addEventListener('click', () => answer(b.dataset.id)));
    const ef = $('#estForm');
    if (ef) ef.addEventListener('submit', (e) => {
      e.preventDefault();
      // punten en komma's zijn duizendtallen ("23.787" of "23,787"): alleen cijfers tellen
      const raw = $('#estimate').value.replace(/[^\d]/g, '');
      const v = Number(raw);
      if (!raw || !isFinite(v)) { toast('Vul een getal in'); return; }
      answer(v);
    });
    const rn = $('#rename');
    if (rn) rn.addEventListener('click', () => {
      const n = (prompt('Nieuwe naam', myName) || '').trim().slice(0, 24);
      if (n && n !== myName) {
        myName = n;
        localStorage.setItem(joinKey(), JSON.stringify({ code, name: n }));
        Store.rename(code, n);
      }
    });
    const lv = $('#leave');
    if (lv) lv.addEventListener('click', leave);
    tick(true);
  }

  /* ---------------- timer ---------------- */
  function tick(once) {
    if (game && game.state && game.state.phase === 'question') {
      const st = game.state;
      const left = st.deadline - Store.now();
      const bar = $('#tbar');
      if (bar) {
        const frac = Math.max(0, Math.min(1, left / st.duration));
        bar.firstChild.style.transform = 'scaleX(' + frac + ')';
        bar.classList.toggle('low', left < 5000);
        $('#tleft').textContent = left > 0 ? Math.ceil(left / 1000) + ' s' : '0 s';
      }
      if (left <= 0) render(); // knoppen op slot (render doet niets als er niets veranderd is)
    }
    if (once !== true) requestAnimationFrame(tick);
  }

  /* ---------------- extra's ---------------- */
  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { /* niet erg */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { requestWakeLock(); lastKey = ''; render(); }
  });

  boot();
})();
