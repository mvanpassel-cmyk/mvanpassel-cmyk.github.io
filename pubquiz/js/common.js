/* common.js: gedeelde hulpfuncties voor quizmaster en spelers */
(function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmt = (n) => (typeof n === 'number' && isFinite(n)) ? n.toLocaleString('nl-NL') : esc(n);

  const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

  /** Totaalscore per speler: som van de punten die de quizmaster per vraag heeft vastgelegd. */
  function totals(game) {
    const t = {};
    const players = (game && game.players) || {};
    Object.keys(players).forEach((id) => { t[id] = 0; });
    const res = (game && game.results) || {};
    Object.keys(res).forEach((k) => {
      const pts = (res[k] && res[k].pts) || {};
      Object.keys(pts).forEach((id) => { t[id] = (t[id] || 0) + pts[id]; });
    });
    return t;
  }

  /** Gesorteerde ranglijst met gedeelde plaatsen bij gelijke stand. */
  function board(game) {
    const t = totals(game);
    const players = (game && game.players) || {};
    const rows = Object.keys(players).map((id) => ({
      id,
      name: players[id].name || '?',
      score: t[id] || 0,
      online: players[id].online !== false
    })).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'nl'));
    let rank = 0, prev = null;
    rows.forEach((r, i) => {
      if (r.score !== prev) { rank = i + 1; prev = r.score; }
      r.rank = rank;
    });
    return rows;
  }

  /** Punten voor één vraag. Wordt alleen door de quizmaster uitgerekend (bij het onthullen). */
  function scoreQuestion(q, answers, durationMs) {
    const pts = {};
    const list = Object.keys(answers || {}).map((id) => [id, answers[id]]);
    if (q.type === 'mc') {
      list.forEach(([id, a]) => {
        if (a && a.a === q.answer) {
          const frac = Math.max(0, Math.min(1, 1 - (Number(a.ms) || 0) / durationMs));
          pts[id] = 10 + Math.round(5 * frac); // 10 voor goed + max. 5 snelheidsbonus
        } else {
          pts[id] = 0;
        }
      });
    } else if (q.type === 'estimate') {
      const diffs = list
        .map(([id, a]) => [id, Math.abs(Number(a && a.a) - q.answer)])
        .filter(([, d]) => isFinite(d))
        .sort((x, y) => x[1] - y[1]);
      const distinct = [...new Set(diffs.map((d) => d[1]))];
      const prize = [15, 8, 4];
      diffs.forEach(([id, d]) => {
        const place = distinct.indexOf(d);
        pts[id] = place >= 0 && place < prize.length ? prize[place] : 0;
      });
    }
    return pts;
  }

  /** Telt stemmen/antwoorden per optie. */
  function tally(answers) {
    const c = {};
    Object.keys(answers || {}).forEach((id) => {
      const a = answers[id] && answers[id].a;
      if (a === undefined || a === null) return;
      c[a] = (c[a] || 0) + 1;
    });
    return c;
  }

  function secs(ms) {
    return (Math.max(0, ms) / 1000).toLocaleString('nl-NL', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  }

  function placeLabel(rank) {
    return rank ? rank + 'e' : '–';
  }

  /** Kleine confetti-regen (alleen CSS-animatie, geen bibliotheek). */
  function confetti(container) {
    const colors = ['#00AEEF', '#EC008C', '#FFE100', '#F4F1EA'];
    const box = document.createElement('div');
    box.className = 'confetti';
    for (let i = 0; i < 80; i++) {
      const p = document.createElement('i');
      p.style.left = Math.random() * 100 + '%';
      p.style.background = colors[i % colors.length];
      p.style.animationDelay = (Math.random() * 1.2) + 's';
      p.style.animationDuration = (2.2 + Math.random() * 1.8) + 's';
      p.style.transform = 'rotate(' + (Math.random() * 360) + 'deg)';
      box.appendChild(p);
    }
    (container || document.body).appendChild(box);
    setTimeout(() => box.remove(), 5000);
  }

  /** Punten per speler over een set vragen (bijv. de vragen van één ronde). */
  function deltas(game, keys) {
    const d = {};
    (keys || []).forEach((k) => {
      const pts = (game && game.results && game.results[k] && game.results[k].pts) || {};
      Object.keys(pts).forEach((id) => { d[id] = (d[id] || 0) + pts[id]; });
    });
    return d;
  }

  function boardHtml(rows, opts) {
    opts = opts || {};
    const limit = opts.limit || rows.length;
    const d = opts.deltas || {};
    const li = (r) => '<li class="' + (r.id === opts.me ? 'me ' : '') + (r.rank === 1 ? 'r1' : '') + '">' +
      '<span class="rk">' + r.rank + '</span>' +
      '<span class="nm">' + esc(r.name) + (r.id === opts.me ? ' <span class="muted small">(jij)</span>' : '') +
      (d[r.id] ? '<span class="delta">+' + d[r.id] + '</span>' : '') + '</span>' +
      '<span class="sc">' + r.score + '</span></li>';
    let html = '<ol class="board">';
    rows.slice(0, limit).forEach((r) => { html += li(r); });
    const meIdx = rows.findIndex((r) => r.id === opts.me);
    if (meIdx >= limit) html += '<li class="gap">⋯</li>' + li(rows[meIdx]);
    if (!rows.length) html += '<li class="gap">Nog geen spelers</li>';
    return html + '</ol>';
  }

  function podiumHtml(rows) {
    const p = rows.slice(0, 3);
    const col = (r, cls, place) => r
      ? '<div class="pl ' + cls + '"><div class="who">' + esc(r.name) + '</div><div class="pts">' + r.score + ' punten</div><div class="blk">' + place + '</div></div>'
      : '<div class="pl ' + cls + '"></div>';
    return '<div class="podium">' + col(p[1], 'p2', p[1] ? p[1].rank : 2) + col(p[0], 'p1', p[0] ? p[0].rank : 1) + col(p[2], 'p3', p[2] ? p[2].rank : 3) + '</div>';
  }

  /** Snelheidsprijs: laagste gemiddelde reactietijd over GOED beantwoorde meerkeuzevragen.
      Wie te weinig goed had, telt niet mee (minimaal 5, of minder als niemand dat haalt). */
  function speedRanking(game) {
    const players = (game && game.players) || {};
    const res = (game && game.results) || {};
    const ans = (game && game.answers) || {};
    const stat = {};
    Object.keys(res).forEach((k) => {
      if (!res[k] || res[k].type !== 'mc') return;
      const pts = res[k].pts || {};
      Object.keys(pts).forEach((id) => {
        const a = ans[k] && ans[k][id];
        if (pts[id] > 0 && a && isFinite(Number(a.ms))) {
          const s = stat[id] || (stat[id] = { n: 0, ms: 0 });
          s.n += 1; s.ms += Number(a.ms);
        }
      });
    });
    let rows = Object.keys(stat).filter((id) => players[id]).map((id) => ({
      id, name: players[id].name || '?', n: stat[id].n, avg: stat[id].ms / stat[id].n }));
    if (!rows.length) return [];
    const maxN = Math.max.apply(null, rows.map((r) => r.n));
    const minN = Math.min(5, maxN);
    rows = rows.filter((r) => r.n >= minN).sort((a, b) => a.avg - b.avg);
    return rows;
  }

  function speedHtml(game, me) {
    const rows = speedRanking(game);
    if (!rows.length) return '';
    const w = rows[0];
    const rest = rows.slice(1, 3).map((r, i) => (i + 2) + '. ' + esc(r.name) + ' (' + secs(r.avg) + ' s)').join(' · ');
    return '<div class="card center speed"><div class="eyebrow">Speciale prijs</div><div class="big-emoji">⚡</div>' +
      '<h2>Snelste reactie</h2><div class="speed-name">' + esc(w.name) + (w.id === me ? ' <span class="muted small">(jij!)</span>' : '') + '</div>' +
      '<p class="muted">gemiddeld <b>' + secs(w.avg) + ' s</b> per goed antwoord (' + w.n + ' goed)</p>' +
      (rest ? '<p class="muted small">' + rest + '</p>' : '') + '</div>';
  }

  /** Onthulling van een vraag: gedeeld door quizmaster en spelers. */
  function revealHtml(game, me, isHost) {
    const st = game.state || {};
    const q = st.q || {};
    const rv = st.reveal || {};
    const answers = (game.answers && game.answers[st.qkey]) || {};
    const players = game.players || {};
    const nameOf = (id) => (players[id] ? players[id].name : '?');
    const counts = tally(answers);
    const mine = me ? answers[me] : null;
    const pts = (game.results && game.results[st.qkey] && game.results[st.qkey].pts) || {};
    const nAns = Object.keys(answers).length;
    let html = '';

    if (q.type === 'mc') {
      html += '<div class="opts">';
      (q.options || []).forEach((o, i) => {
        const cls = ['opt', 'o' + i];
        if (i === rv.correct) cls.push('correct'); else cls.push('dim');
        if (mine && mine.a === i) cls.push('chosen');
        html += '<div class="' + cls.join(' ') + '"><span class="letter">' + LETTERS[i] + '</span><span class="label">' + esc(o) + '</span>' +
          '<span class="count">' + (counts[i] || 0) + '</span></div>';
      });
      html += '</div>';
      if (isHost) {
        const right = Object.keys(answers).filter((id) => answers[id].a === rv.correct);
        right.sort((a, b) => (answers[a].ms || 0) - (answers[b].ms || 0));
        html += '<p class="muted">' + right.length + ' van de ' + nAns + ' antwoorden goed.' +
          (right.length ? ' Snelste: <b>' + esc(nameOf(right[0])) + '</b> (' + secs(answers[right[0]].ms) + ' s).' : '') + '</p>';
      }
    } else if (q.type === 'vote') {
      const rows = Object.keys(counts).map((id) => [id, counts[id]]).sort((a, b) => b[1] - a[1]);
      const max = rows.length ? rows[0][1] : 1;
      html += '<div class="bars">';
      rows.slice(0, isHost ? 8 : 5).forEach(([id, n], i) => {
        html += '<div class="bar"><span>' + (i === 0 ? '👑 ' : '') + esc(nameOf(id)) + '</span>' +
          '<span class="track"><span class="fill" style="width:' + Math.round(100 * n / max) + '%"></span></span>' +
          '<span class="n">' + n + '</span></div>';
      });
      if (!rows.length) html += '<p class="muted">Niemand heeft gestemd.</p>';
      html += '</div>';
      if (mine) html += '<p class="muted small">Jij stemde op <b>' + esc(nameOf(mine.a)) + '</b>.</p>';
    } else if (q.type === 'estimate') {
      html += '<div class="center"><div class="eyebrow">Het goede antwoord</div><div class="score-pop">' + fmt(rv.correct) + '</div>' +
        (q.unit ? '<div class="muted">' + esc(q.unit) + '</div>' : '') + '</div>';
      const rows = Object.keys(answers).map((id) => [id, Number(answers[id].a)]).filter(([, v]) => isFinite(v))
        .sort((a, b) => Math.abs(a[1] - rv.correct) - Math.abs(b[1] - rv.correct));
      html += '<ol class="board" style="margin-top:12px">';
      rows.slice(0, isHost ? 10 : 5).forEach(([id, v]) => {
        html += '<li class="' + (id === me ? 'me' : '') + '"><span class="rk">' + (pts[id] ? '+' + pts[id] : '') + '</span>' +
          '<span class="nm">' + esc(nameOf(id)) + '</span><span class="sc">' + fmt(v) + '</span></li>';
      });
      html += '</ol>';
    }
    if (rv.info) html += '<div class="info">💡 ' + esc(rv.info) + '</div>';
    return html;
  }

  function registerSW() {
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  window.QZ = { esc, fmt, LETTERS, totals, board, scoreQuestion, tally, secs, placeLabel, confetti, registerSW, deltas, boardHtml, podiumHtml, revealHtml, speedRanking, speedHtml };
})();
