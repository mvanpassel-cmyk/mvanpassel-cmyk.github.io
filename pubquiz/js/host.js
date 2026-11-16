/* host.js: het scherm van de quizmaster */
(function () {
  'use strict';

  const $ = (s, el) => (el || document).querySelector(s);
  const esc = QZ.esc;
  const app = $('#app');
  const params = new URLSearchParams(location.search);
  const QUIZ = window.QUIZ || { rounds: [] };
  const DEFAULT_TIME = QUIZ.defaultTime || 30;

  /* ---------- vragenlijst plat slaan ---------- */
  const items = [];
  let skippedTodo = 0;
  const usedRounds = [];
  QUIZ.rounds.forEach((r, ri) => {
    const qs = (r.questions || []).filter((q) => { if (q.todo) { skippedTodo++; return false; } return true; });
    if (!qs.length) return;
    usedRounds.push(ri);
    qs.forEach((q) => items.push(Object.assign({}, q, { type: q.type || 'mc', roundIdx: ri, roundTitle: r.title, roundEmoji: r.emoji || '' })));
  });
  let n = 0;
  items.forEach((it, i) => {
    it.key = 'q' + String(i + 1).padStart(2, '0');
    if (it.type !== 'vote') it.num = ++n;
  });
  const scoredTotal = n;
  const roundNo = (ri) => usedRounds.indexOf(ri) + 1;

  let code = (params.get('c') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  let game = null;
  let connected = true;
  let unsub = null;
  let autoReveal = true;
  let peek = true;
  let closingFor = null;
  let revealTimer = null;
  let lastHtml = '';
  let confettiDone = false;
  const LAST = 'pubquiz-host-last';

  /* ---------------- opstart ---------------- */
  async function boot() {
    QZ.registerSW();
    app.innerHTML = '<div class="wrap"><p class="pulse">Verbinden…</p></div>';
    try {
      await Store.init();
    } catch (e) {
      console.error(e);
      app.innerHTML = '<div class="wrap"><div class="banner err">Kan Firebase niet bereiken. Klopt firebase-config.js en staat Anonymous sign-in aan? (' + esc(e.message) + ')</div></div>';
      return;
    }
    Store.onConnection((c) => { connected = c; lastHtml = ''; render(); });
    if (code) return openGame(code);
    showSetup();
  }

  function randomCode() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let s = '';
    for (let i = 0; i < 4; i++) s += abc[Math.floor(Math.random() * abc.length)];
    return s;
  }

  function header() {
    const ps = (game && game.players) || {};
    const ids = Object.keys(ps);
    const on = ids.filter((id) => ps[id].online !== false).length;
    return '<header class="top"><div class="brand"><img class="logo" src="favicon.svg" alt=""><span>' + esc(QUIZ.title || 'Pubquiz') + ' · quizmaster</span></div>' +
      '<div class="spacer"></div>' +
      (game ? '<span class="pill">👥 ' + on + (ids.length !== on ? ' / ' + ids.length : '') + '</span>' : '') +
      (code && game ? '<span class="pill">Code <b>' + esc(code) + '</b></span>' : '') +
      '<span class="pill"><i class="dot ' + (connected ? 'on' : 'off') + '"></i>' + (connected ? '' : 'offline') + '</span></header>';
  }

  function banners() {
    let b = '';
    if (Store.isDemo) b += '<div class="banner">Demo-modus: Firebase is nog niet ingesteld (firebase-config.js). Spelers kunnen alleen meedoen in andere tabbladen van deze browser. Prima om te oefenen!</div>';
    if (skippedTodo) b += '<div class="banner">' + skippedTodo + ' vraag' + (skippedTodo === 1 ? '' : 'en') + ' met <b>todo: true</b> in questions.js nog niet ingevuld. Die worden overgeslagen.</div>';
    if (!connected) b += '<div class="banner err">Geen verbinding. Wat je nu doet wordt verstuurd zodra je weer online bent.</div>';
    return b;
  }

  /* ---------------- nieuw spel ---------------- */
  function showSetup(error) {
    const last = localStorage.getItem(LAST);
    app.innerHTML = '<div class="wrap">' + header() + banners() +
      '<div class="card"><h1>Nieuwe quiz starten</h1>' +
      '<p class="muted">' + items.length + ' onderdelen: ' + scoredTotal + ' vragen met punten en ' + (items.length - scoredTotal) + ' stemvragen, in ' + usedRounds.length + ' rondes.</p>' +
      (error ? '<div class="banner err">' + esc(error) + '</div>' : '') +
      '<form id="newForm"><label for="code">Spelcode</label>' +
      '<input id="code" class="code" type="text" maxlength="8" value="' + randomCode() + '">' +
      '<p class="muted small">Kies zelf iets (bijv. BONN) of laat de willekeurige code staan.</p>' +
      '<button class="btn primary block" type="submit">Maak spel ▶</button></form>' +
      (last ? '<button class="btn ghost block" id="resume">Verder met spel ' + esc(last) + '</button>' : '') +
      '</div>' + questionList(-1) + '</div>';
    $('#newForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const c = $('#code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (c.length < 3) return showSetup('Gebruik minstens 3 letters of cijfers.');
      openGame(c);
    });
    const r = $('#resume');
    if (r) r.addEventListener('click', () => openGame(last));
  }

  async function openGame(c) {
    let res;
    try {
      res = await Store.claimHost(c, { title: QUIZ.title || 'Pubquiz', subtitle: QUIZ.subtitle || '' });
    } catch (e) {
      console.error(e);
      return showSetup('Spel aanmaken lukte niet: ' + e.message);
    }
    if (res === 'taken') {
      code = '';
      return showSetup('Code ' + c + ' is al in gebruik door een ander apparaat. Kies een andere code.');
    }
    code = c;
    localStorage.setItem(LAST, c);
    const q = new URLSearchParams(location.search);
    q.set('c', c);
    history.replaceState(null, '', '?' + q.toString());
    if (unsub) unsub();
    unsub = Store.subscribe(c, onGame);
  }

  function onGame(g) {
    if (!g) {
      game = null;
      localStorage.removeItem(LAST);
      code = '';
      history.replaceState(null, '', location.pathname + (Store.isDemo && params.has('demo') ? '?demo' : ''));
      return showSetup();
    }
    game = g;
    const st = g.state || {};
    if (st.phase === 'closing') scheduleReveal();
    render();
  }

  /* ---------------- spelverloop ---------------- */
  const state = () => (game && game.state) || { phase: 'lobby' };
  const setState = (s) => Store.hostUpdate(code, { state: s });

  function playersSorted() {
    const ps = (game && game.players) || {};
    return Object.keys(ps).map((id) => ({ id, name: ps[id].name || '?' }))
      .sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  }

  function goItem(i) {
    if (i >= items.length) return goFinal();
    const it = items[i];
    const newRound = i === 0 || items[i - 1].roundIdx !== it.roundIdx;
    if (newRound) {
      const count = items.filter((x) => x.roundIdx === it.roundIdx).length;
      return setState({ phase: 'intro', idx: i, round: { no: roundNo(it.roundIdx), of: usedRounds.length, title: it.roundTitle, emoji: it.roundEmoji, count } });
    }
    return startQuestion(i);
  }

  function startQuestion(i) {
    const it = items[i];
    const duration = (it.time || DEFAULT_TIME) * 1000;
    const startedAt = Math.round(Store.now());
    const q = { type: it.type, text: it.q, cat: it.roundTitle, emoji: it.roundEmoji, num: it.num || 0, total: scoredTotal };
    if (it.unit) q.unit = it.unit;
    if (it.type === 'mc') q.options = it.options;
    if (it.type === 'vote') q.options = playersSorted();
    closingFor = null;
    return setState({ phase: 'question', idx: i, qkey: it.key, q, startedAt, duration, deadline: startedAt + duration });
  }

  function closeQuestion() {
    const st = state();
    if (st.phase !== 'question' || closingFor === st.qkey) return;
    closingFor = st.qkey;
    Store.hostUpdate(code, { 'state/phase': 'closing' });
    scheduleReveal();
  }

  // even wachten zodat antwoorden die nog onderweg waren ook meetellen
  function scheduleReveal() {
    if (revealTimer) return;
    revealTimer = setTimeout(() => { revealTimer = null; doReveal(); }, 1600);
  }

  function doReveal() {
    const st = state();
    if (st.phase !== 'closing') return;
    const it = items[st.idx];
    if (!it) return;
    const answers = (game.answers && game.answers[st.qkey]) || {};
    const patch = {
      'state/phase': 'reveal',
      'state/reveal': { correct: it.type === 'vote' ? null : it.answer, info: it.info || null }
    };
    if (it.type !== 'vote') patch['results/' + st.qkey] = { type: it.type, pts: QZ.scoreQuestion(it, answers, st.duration) };
    Store.hostUpdate(code, patch);
  }

  function goScores(i) {
    const ri = items[i].roundIdx;
    const keys = items.filter((x) => x.roundIdx === ri && x.type !== 'vote').map((x) => x.key);
    return setState({ phase: 'scores', idx: i, roundNo: roundNo(ri), roundTitle: items[i].roundTitle, keys });
  }

  function goFinal() { return setState({ phase: 'final', idx: items.length - 1 }); }

  function afterItem(i) {
    if (i >= items.length - 1) return goFinal();
    if (items[i + 1].roundIdx !== items[i].roundIdx) return goScores(i);
    return goItem(i + 1);
  }

  function next() {
    const st = state();
    switch (st.phase) {
      case 'lobby': return goItem(0);
      case 'intro': return startQuestion(st.idx);
      case 'question': return closeQuestion();
      case 'reveal': return afterItem(st.idx);
      case 'scores': return goItem(st.idx + 1);
      default: return null;
    }
  }

  function skip() {
    const st = state();
    if (st.phase === 'intro' || st.phase === 'question') {
      if (!confirm('Deze vraag overslaan zonder punten?')) return;
      return afterItem(st.idx);
    }
  }

  function addTime() {
    const st = state();
    if (st.phase === 'question') Store.hostUpdate(code, { 'state/deadline': st.deadline + 15000 });
  }

  function nextLabel() {
    const st = state();
    switch (st.phase) {
      case 'lobby': return 'Start de quiz ▶';
      case 'intro': return 'Start vraag ▶';
      case 'question': return 'Stop & onthul ⏹';
      case 'closing': return 'Even rekenen…';
      case 'reveal': {
        if (st.idx >= items.length - 1) return 'Naar de eindstand 🏆';
        if (items[st.idx + 1].roundIdx !== items[st.idx].roundIdx) return 'Toon tussenstand ▶';
        return 'Volgende vraag ▶';
      }
      case 'scores': return 'Volgende ronde ▶';
      case 'final': return 'Klaar! 🎉';
      default: return 'Volgende ▶';
    }
  }

  /* ---------------- weergave ---------------- */
  function joinUrl() {
    const u = new URL('index.html', location.href);
    u.search = '';
    u.searchParams.set('c', code);
    if (params.has('demo')) u.searchParams.set('demo', '');
    return u.toString().replace('demo=', 'demo');
  }

  // Wie telt mee voor "iedereen heeft geantwoord"? Wie online is, plus wie korter dan
  // 90 seconden offline is (tunnel!). Wie langer weg is, laat de quiz niet wachten.
  function activePlayers() {
    const ps = (game && game.players) || {};
    const now = Store.now();
    return Object.keys(ps).filter((id) => ps[id].online !== false || (ps[id].offAt && now - ps[id].offAt < 90000));
  }

  function answersNow() {
    const st = state();
    return (game && game.answers && st.qkey && game.answers[st.qkey]) || {};
  }

  function stage() {
    const st = state();
    const ps = (game && game.players) || {};
    const ids = Object.keys(ps);
    switch (st.phase) {
      case 'lobby': {
        const url = joinUrl();
        return '<div class="card"><div class="eyebrow">' + esc(QUIZ.subtitle || '') + '</div><h1>' + esc(QUIZ.title || 'Pubquiz') + '</h1>' +
          '<p>Deel deze link in de Signal-groep. Collega\'s tikken erop, vullen hun naam in en zijn binnen.</p>' +
          '<div class="linkbox" id="link">' + esc(url) + '</div>' +
          '<div class="row" style="margin-top:10px">' +
          (navigator.share ? '<button class="btn magenta" id="share">Delen…</button>' : '') +
          '<button class="btn" id="copy">Kopieer link</button>' +
          '<button class="btn ghost" id="copyMsg">Kopieer uitnodiging</button></div>' +
          '<div class="codebig">' + esc(code) + '</div><p class="center muted small">Of: open de quizpagina en typ deze code.</p></div>' +
          '<div class="card"><div class="eyebrow" style="margin-bottom:8px">Binnen (' + ids.length + ')</div>' +
          (ids.length ? '<div class="chips">' + ids.map((id) => '<span class="chip"><i class="dot ' + (ps[id].online !== false ? 'on' : '') + '"></i>' + esc(ps[id].name) + '</span>').join('') + '</div>'
            : '<p class="muted pulse">Nog niemand… deel de link!</p>') + '</div>';
      }
      case 'intro': {
        const r = st.round || {};
        return '<div class="card center"><div class="eyebrow">Ronde ' + r.no + ' van ' + r.of + '</div><div class="big-emoji">' + esc(r.emoji) + '</div><h1>' + esc(r.title) + '</h1>' +
          '<p class="muted">' + r.count + (r.count === 1 ? ' vraag' : ' vragen') + '</p></div>';
      }
      case 'question':
      case 'closing': {
        const q = st.q || {};
        const it = items[st.idx] || {};
        const ans = answersNow();
        const nAns = Object.keys(ans).length;
        const on = activePlayers().length;
        let body = '';
        if (q.type === 'mc') {
          body = '<div class="opts two">' + (q.options || []).map((o, i) =>
            '<div class="opt o' + i + (peek && i === it.answer ? ' hostkey' : '') + '"><span class="letter">' + QZ.LETTERS[i] + '</span><span class="label">' + esc(o) + '</span></div>').join('') + '</div>' +
            (peek ? '<p class="muted small">Gestippeld = goede antwoord (alleen jij ziet dit).</p>' : '');
        } else if (q.type === 'vote') {
          body = '<p class="muted">Iedereen kiest een collega. Geen punten, wel eer.</p>';
        } else if (q.type === 'estimate') {
          body = '<p class="muted">Spelers typen een getal.' + (peek ? ' Antwoord: <b>' + QZ.fmt(it.answer) + '</b>' : '') + '</p>';
        }
        return '<div class="card"><div class="eyebrow">' + esc(q.emoji) + ' ' + esc(q.cat) + ' · ' + (q.type === 'vote' ? 'Stemvraag' : 'Vraag ' + q.num + ' van ' + q.total) + '</div>' +
          '<div class="qtext">' + esc(q.text) + '</div>' +
          '<div class="timer" id="tbar"><i></i></div><div class="timer-row"><span id="tleft"></span><span><b>' + nAns + '</b> / ' + on + ' geantwoord</span></div>' +
          body + (st.phase === 'closing' ? '<p class="center pulse">⏰ Tijd is om, antwoorden worden verwerkt…</p>' : '') + '</div>';
      }
      case 'reveal': {
        const q = st.q || {};
        return '<div class="card"><div class="eyebrow">' + esc(q.emoji) + ' ' + esc(q.cat) + ' · ' + (q.type === 'vote' ? 'Stemvraag' : 'Vraag ' + q.num + ' van ' + q.total) + '</div>' +
          '<div class="qtext">' + esc(q.text) + '</div>' + QZ.revealHtml(game, null, true) + '</div>';
      }
      case 'scores': {
        const rows = QZ.board(game);
        return '<div class="card"><div class="eyebrow">Na ronde ' + st.roundNo + ': ' + esc(st.roundTitle) + '</div><h2>Tussenstand</h2>' +
          QZ.boardHtml(rows, { deltas: QZ.deltas(game, st.keys || []) }) + '</div>';
      }
      case 'final': {
        const rows = QZ.board(game);
        return '<div class="card center"><div class="big-emoji">🏆</div><h1>Eindstand</h1>' + QZ.podiumHtml(rows) + '</div>' +
          '<div class="card">' + QZ.boardHtml(rows) + '</div>';
      }
      default: return '';
    }
  }

  function controls() {
    const st = state();
    const busy = st.phase === 'closing' || st.phase === 'final';
    return '<div class="card controls">' +
      '<button class="btn primary" id="next"' + (busy ? ' disabled' : '') + '>' + nextLabel() + '</button>' +
      '<div class="row">' +
      '<button class="btn small grow" id="plus"' + (st.phase === 'question' ? '' : ' disabled') + '>+15 s</button>' +
      '<button class="btn small grow" id="skip"' + (st.phase === 'intro' || st.phase === 'question' ? '' : ' disabled') + '>Overslaan</button></div>' +
      '<label class="check"><input type="checkbox" id="auto"' + (autoReveal ? ' checked' : '') + '> Automatisch stoppen als de tijd om is of iedereen heeft geantwoord</label>' +
      '<label class="check"><input type="checkbox" id="peek"' + (peek ? ' checked' : '') + '> Toon mij het goede antwoord</label>' +
      '<p class="muted tiny">Sneltoets: <span class="kbd">spatie</span> of <span class="kbd">→</span> = volgende.</p>' +
      '</div>';
  }

  function playersPanel() {
    const rows = QZ.board(game);
    const ans = answersNow();
    const st = state();
    const showAns = st.phase === 'question' || st.phase === 'closing';
    return '<div class="card"><div class="eyebrow" style="margin-bottom:8px">Spelers &amp; score</div>' +
      (rows.length ? '<ol class="board">' + rows.map((r) =>
        '<li><span class="rk">' + r.rank + '</span><span class="nm"><i class="dot ' + (r.online ? 'on' : '') + '"></i> ' + esc(r.name) +
        (showAns && ans[r.id] ? ' ✅' : '') + '</span><span class="sc">' + r.score + '</span></li>').join('') + '</ol>'
        : '<p class="muted">Nog geen spelers.</p>') + '</div>';
  }

  function questionList(cur) {
    let lastRound = -1;
    let html = '<div class="card"><div class="eyebrow" style="margin-bottom:8px">Programma</div><ul class="list-q">';
    items.forEach((it, i) => {
      if (it.roundIdx !== lastRound) {
        lastRound = it.roundIdx;
        html += '<li><b>' + esc(it.roundEmoji) + ' ' + esc(it.roundTitle) + '</b></li>';
      }
      html += '<li class="' + (i === cur ? 'cur' : i < cur ? 'done' : '') + '"><span>' + (it.type === 'vote' ? '🗳️' : it.num + '.') + '</span><span>' + esc(it.q) + '</span></li>';
    });
    if (skippedTodo) html += '<li class="todo">+ ' + skippedTodo + ' nog in te vullen (todo)</li>';
    return html + '</ul></div>';
  }

  function render() {
    if (!game) return;
    const st = state();
    const html = '<div class="wrap wide">' + header() + banners() +
      '<div class="host-grid"><div>' + stage() + '</div><aside>' + controls() + playersPanel() + questionList(st.phase === 'lobby' ? -1 : st.idx) +
      '<div class="card"><button class="btn danger small" id="del">Spel verwijderen</button> <span class="muted tiny">Wist alle namen en antwoorden.</span></div></aside></div></div>';
    if (html === lastHtml) return;
    lastHtml = html;
    app.innerHTML = html;
    bind();
    tick(true);
    const list = $('.list-q');
    const cur = list && list.querySelector('li.cur');
    if (cur) list.scrollTop = Math.max(0, cur.offsetTop - list.offsetTop - 60);
    if (st.phase === 'final' && !confettiDone) { confettiDone = true; QZ.confetti(); }
  }

  function bind() {
    const on = (id, ev, fn) => { const el = $('#' + id); if (el) el.addEventListener(ev, fn); };
    on('next', 'click', next);
    on('plus', 'click', addTime);
    on('skip', 'click', skip);
    on('auto', 'change', (e) => { autoReveal = e.target.checked; });
    on('peek', 'change', (e) => { peek = e.target.checked; lastHtml = ''; render(); });
    on('copy', 'click', () => copy(joinUrl(), 'Link gekopieerd'));
    on('copyMsg', 'click', () => copy(invite(), 'Uitnodiging gekopieerd. Plak hem in Signal.'));
    on('share', 'click', () => navigator.share({ title: QUIZ.title, text: invite(false), url: joinUrl() }).catch(() => {}));
    on('del', 'click', async () => {
      if (!confirm('Spel ' + code + ' en alle antwoorden verwijderen?')) return;
      await Store.deleteGame(code);
    });
  }

  function invite(withUrl) {
    return '🚆 Pubquiz in de trein naar Bonn! Tik op de link, vul je naam in en doe mee' +
      (withUrl === false ? '' : ': ' + joinUrl()) + ' (code ' + code + ')';
  }

  function copy(text, msg) {
    const done = () => toast(msg);
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => fallback());
    else fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { prompt('Kopieer:', text); }
      ta.remove();
    }
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  /* ---------------- timer & automatisch stoppen ---------------- */
  function tick(once) {
    const st = state();
    if (game && st.phase === 'question') {
      const left = st.deadline - Store.now();
      const bar = $('#tbar');
      if (bar) {
        bar.firstChild.style.transform = 'scaleX(' + Math.max(0, Math.min(1, left / st.duration)) + ')';
        bar.classList.toggle('low', left < 5000);
        $('#tleft').textContent = Math.max(0, Math.ceil(left / 1000)) + ' s';
      }
      if (autoReveal && once !== true) {
        const ans = answersNow();
        const act = activePlayers();
        const allIn = act.length > 0 && act.every((id) => ans[id]);
        if (left < -300 || allIn) closeQuestion();
      }
    }
  }
  setInterval(() => tick(false), 200);

  document.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.code === 'Space' || e.key === 'ArrowRight') {
      e.preventDefault();
      const b = $('#next');
      if (b && !b.disabled) next();
    }
  });

  boot();
})();
