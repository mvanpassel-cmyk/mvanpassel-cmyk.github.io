/* Comfort Zone: draws your reading bubble from the log kept by /shared/zone-log.js,
   then shows front pages, countries and topics from just outside it. */
(() => {
"use strict";
const $ = s => document.querySelector(s);
const KEY = "comfortZone.log";
const DAY = 864e5, WINDOW = 90 * DAY;
const REGIONS = ["Africa", "Americas", "Eastern Mediterranean", "Europe", "South-East Asia", "Western Pacific"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = iso => { if (!iso) return ""; const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return `${d} ${MONTHS[m - 1]}`; };

/* Topics are read from the words of what you click (mostly English headlines). */
const TOPICS = [
  ["Outbreaks", s => /outbreak|epidemic|ebola|cholera|mpox|measles|dengue|marburg|polio|bird flu|avian|h5n1|nipah|plague|lassa/i.test(s)],
  ["AMR", s => /antimicrobial|antibiotic|\bAMR\b|superbug|drug.resistan/i.test(s)],
  ["WHO & treaties", s => /\bWHO\b|World Health|pandemic (agreement|treaty|accord)|\bIHR\b|\bPABS\b|Health Assembly/.test(s)],
  ["Money & aid", s => /fund|financ|budget|\baid\b|donor|USAID|Gavi|debt|\bcuts?\b/i.test(s)],
  ["Climate", s => /climate|heat ?wave|flood|drought|pollution|air quality|environment/i.test(s)],
  ["Chronic disease", s => /cancer|diabet|obesity|hypertens|heart|stroke|tobacco|alcohol|\bNCDs?\b/i.test(s)],
  ["Mental health", s => /mental|suicid|depress|anxiety|psychiat/i.test(s)],
  ["Mothers & children", s => /maternal|mothers?\b|newborn|child|infant|pregnan|midwi/i.test(s)],
  ["Conflict", s => /\bwar\b|conflict|attack|refugee|humanitarian|displace|ceasefire/i.test(s)],
  ["Medicines & vaccines", s => /vaccin|medicine|\bdrugs?\b|pharma|immunis|immuniz|shortage/i.test(s)],
  ["Digital & AI", s => /digital|\bAI\b|artificial intelligence|\bdata\b|cyber/i.test(s)],
  ["Health workers", s => /nurse|doctor|health workers?|workforce|strike|salar/i.test(s)],
];

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v; else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}
const link = (text, url) => h("a", { href: url, rel: "noopener" }, text);
const getJSON = (p, fb) => fetch(p, { cache: "no-cache" }).then(r => r.ok ? r.json() : fb).catch(() => fb);
const readLog = () => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (_) { return []; } };
function seeded(seedText) {           // small deterministic random generator
  let a = 0; for (const ch of seedText) a = (a * 31 + ch.charCodeAt(0)) | 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;

let WORLD = [], BYISO = {}, BYSLUG = {}, SHADOW = [], FRONT = { editions: [] }, A = null, shuffles = 0;

async function boot() {
  const [world, desk, shadow, front] = await Promise.all([
    getJSON("../country-desk/data/shadow/world.json", { countries: [] }), getJSON("../country-desk/data/countries.json", { countries: [] }),
    getJSON("../country-desk/data/shadow/index.json", { countries: [] }), getJSON("data/frontpages.json", { editions: [] })]);
  WORLD = world.countries; SHADOW = shadow.countries; FRONT = front;
  for (const c of WORLD) { BYISO[c.iso3] = c; BYSLUG[c.slug] = c.iso3; if (c.desk) BYSLUG[c.desk] = c.iso3; BYSLUG[c.iso3.toLowerCase()] = c.iso3; }
  for (const c of desk.countries || []) BYSLUG[c.slug] = c.iso3;
  A = analyse(readLog());
  render();
  $("#forget").addEventListener("click", forget);
  $("#shuffle").addEventListener("click", () => { shuffles++; renderPages(); $("#pages").scrollIntoView({ behavior: "smooth", block: "start" }); });
}

/* ---------- reading the log ---------- */
function nameMatcher() {
  const pairs = [];
  for (const c of WORLD) for (const n of c.names) if (n.length >= 4 && /^[A-Za-zÀ-ÿ .,'’()\-]+$/.test(n) && c.iso3 !== "NLD") pairs.push([n, c.iso3]);
  pairs.sort((a, b) => b[0].length - a[0].length);
  const map = Object.fromEntries(pairs.map(([n, i]) => [n.toLowerCase(), i]));
  const rx = new RegExp("(?<![\\w-])(" + pairs.map(([n]) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")(?![\\w-])", "gi");
  return text => [...new Set([...(text || "").matchAll(rx)].map(m => map[m[1].toLowerCase()]).filter(Boolean))];
}

function analyse(log) {
  const now = Date.now(), ev = log.filter(e => e && e.t > now - WINDOW);
  const countries = {}, regions = Object.fromEntries(REGIONS.map(r => [r, 0])), topics = Object.fromEntries(TOPICS.map(([t]) => [t, 0])), hosts = {}, lastRegion = {};
  const match = nameMatcher();
  const addCountry = (iso, w, t) => {
    countries[iso] = (countries[iso] || 0) + w;
    const r = (BYISO[iso] || {}).region;
    if (r in regions) { regions[r] += w; lastRegion[r] = Math.max(lastRegion[r] || 0, t); }
  };
  let views = 0, clicks = 0;
  for (const e of ev) {
    if (e.k === "view") views++; else clicks++;
    const ctxIso = e.ctx && BYSLUG[e.ctx];
    if (ctxIso) addCountry(ctxIso, e.k === "view" ? 2 : 1, e.t);
    if (e.title) {
      for (const iso of match(e.title)) if (iso !== ctxIso) addCountry(iso, 1, e.t);
      for (const [t, test] of TOPICS) if (test(e.title)) topics[t]++;
    }
    if (e.host) hosts[e.host] = (hosts[e.host] || 0) + 1;
  }
  const learning = views + clicks < 12;
  if (learning) {                       // until there is enough to go on, assume the desk countries are home ground
    for (const c of WORLD) if (c.desk) { countries[c.iso3] = (countries[c.iso3] || 0) + 0.5; if (c.region in regions) regions[c.region] += 0.5; }
    for (const t of ["Outbreaks", "WHO & treaties", "AMR"]) topics[t] += 1;
  }
  return { ev, views, clicks, countries, regions, topics, hosts, lastRegion, learning, first: ev.length ? ev[0].t : 0 };
}

/* ---------- render ---------- */
function render() {
  renderVerdict(); renderMap(); renderStats(); renderPages(); renderCards();
  $("#foot").textContent = `Front pages of ${shortDate(FRONT.generated)}. Your map: ${A.views} page views and ${A.clicks} clicks in the past 90 days` + (A.first ? `, since ${shortDate(new Date(A.first).toISOString())}.` : ".");
}

function renderVerdict() {
  const tot = Object.values(A.regions).reduce((a, b) => a + b, 0);
  const sorted = REGIONS.slice().sort((a, b) => A.regions[b] - A.regions[a]);
  const empty = REGIONS.filter(r => !A.regions[r]);
  const v = $("#verdict");
  if (!tot) { v.textContent = "Your map is empty. Browse your tools for a while and come back: the bubble draws itself."; return; }
  const tail = empty.length
    ? (empty.length === 1 ? `${empty[0]} has` : `${empty.slice(0, -1).join(", ")} and ${empty.at(-1)} have`) + " had nothing from you in 90 days."
    : `${sorted.at(-1)} gets the least: ${pct(A.regions[sorted.at(-1)], tot)}%.`;
  v.replaceChildren(`${pct(A.regions[sorted[0]], tot)}% of what you read is about `, h("b", { text: sorted[0] }), ". " + tail);
  if (A.learning) $(".top").before(h("div", { class: "learning", text: "Still learning. Until you have browsed your tools a bit, the map assumes your Country Desk countries and your usual topics are home ground. Open the Ribbon, Country Desk or Long View as you normally would; this page fills in." }));
}

function renderMap() {
  const W = 640, C = W / 2, NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `-96 -4 ${W + 192} ${W + 8}`); svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Your reading bubble: regions and topics close to the centre are what you read most; those at the rim you hardly read");
  const el = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; svg.append(e); return e; };
  [[286, "var(--ring)"], [206, "color-mix(in srgb,var(--y) 22%,var(--panel))"], [118, "color-mix(in srgb,var(--c) 18%,var(--panel))"]]
    .forEach(([r, f]) => el("circle", { cx: C, cy: C, r, fill: f, stroke: "var(--line)" }));
  el("text", { x: C, y: C - 100, "text-anchor": "middle", class: "zl" }, "Comfort");
  el("text", { x: C, y: C - 182, "text-anchor": "middle", class: "zl" }, "Stretch");
  el("text", { x: C, y: C - 262, "text-anchor": "middle", class: "zl" }, "Rim");
  const items = [];
  const rmax = Math.max(1e-9, ...Object.values(A.regions)), tmax = Math.max(1e-9, ...Object.values(A.topics));
  REGIONS.forEach(r => items.push({ label: r, share: A.regions[r] / rmax, kind: "r" }));
  TOPICS.forEach(([t]) => items.push({ label: t, share: A.topics[t] / tmax, kind: "t" }));
  const order = []; let ri = 0, ti = 0;          // one region, then two topics, round the circle
  for (let i = 0; i < items.length; i++) order.push(i % 3 === 0 && ri < REGIONS.length ? items[ri++] : items[REGIONS.length + ti++]);
  order.forEach((it, i) => {
    const ang = -Math.PI / 2 + i / order.length * Math.PI * 2 + 0.17;
    const r = 52 + Math.pow(1 - it.share, 0.7) * 226;
    const x = C + Math.cos(ang) * r, y = C + Math.sin(ang) * r;
    el("line", { x1: C, y1: C, x2: x, y2: y, stroke: "var(--line)", "stroke-width": 1 });
    el("circle", { cx: x, cy: y, r: it.kind === "r" ? 9 : 6.5, fill: it.kind === "r" ? "var(--c)" : "var(--m)", style: "mix-blend-mode:multiply" });
    const right = Math.cos(ang) >= 0;
    el("text", { x: x + (right ? 12 : -12), y: y + 4, "text-anchor": right ? "start" : "end" }, it.label);
  });
  el("circle", { cx: C, cy: C, r: 7, fill: "var(--ink)" });
  el("text", { x: C, y: C + 22, "text-anchor": "middle" }, "you");
  $("#map").replaceChildren(svg);
}

function renderStats() {
  const top = Object.entries(A.countries).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([iso]) => (BYISO[iso] || {}).name).filter(Boolean);
  const hostList = Object.entries(A.hosts).sort((a, b) => b[1] - a[1]), hostTot = hostList.reduce((s, [, n]) => s + n, 0);
  const top3 = hostList.slice(0, 3).reduce((s, [, n]) => s + n, 0);
  const skipped = TOPICS.map(([t]) => t).filter(t => !A.topics[t]);
  const now = Date.now();
  const quiet = REGIONS.map(r => [r, A.lastRegion[r] ? Math.round((now - A.lastRegion[r]) / DAY) : null]).sort((a, b) => (b[1] ?? 999) - (a[1] ?? 999))[0];
  const row = (k, v) => h("div", null, h("dt", { text: k }), h("dd", null, v));
  $("#stats").replaceChildren(h("h2", { text: "Your bubble" }), h("dl", null,
    row("Home ground", top.length ? top.join(", ") : "Nothing yet"),
    row("Sources", hostTot ? `${hostList.length} different sites; the top three give ${pct(top3, hostTot)}% of your clicks (${hostList.slice(0, 3).map(([d]) => d).join(", ")}).` : "No outside clicks recorded yet."),
    row("Topics you skip", skipped.length ? skipped.join(", ") : "None: you read across all twelve."),
    row("Longest silence", quiet ? `${quiet[0]}: ` + (quiet[1] == null ? "nothing in 90 days" : `last read ${quiet[1]} days ago`) : "—")),
    h("p", { class: "note", text: "Regions are WHO regions. Countries count when you open their Country Desk page or click a headline that names them." }));
}

function edgeEditions() {
  const tot = Object.values(A.regions).reduce((a, b) => a + b, 0) || 1;
  const scored = (FRONT.editions || []).map(e => {
    const reg = (BYISO[e.iso3] || {}).region || "";
    return { e, reg, score: (A.regions[reg] || 0) / tot * 100 + (A.countries[e.iso3] || 0) * 3 };
  }).sort((a, b) => a.score - b.score);
  const pool = scored.slice(0, Math.max(9, Math.ceil(scored.length / 3)));
  const rnd = seeded(new Date().toISOString().slice(0, 10) + "#" + shuffles);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const out = [], regs = new Set();
  for (const p of pool) { if (out.length < 3 && !regs.has(p.reg)) { out.push(p); regs.add(p.reg); } }
  for (const p of pool) if (out.length < 3 && !out.includes(p)) out.push(p);
  return out;
}

function renderPages() {
  const tot = Object.values(A.regions).reduce((a, b) => a + b, 0) || 1;
  const bars = ["var(--c)", "var(--m)", "var(--y)"];
  const picks = edgeEditions();
  $("#pages").replaceChildren(...(picks.length ? picks.map((p, i) => {
    const e = p.e, foreign = !["en", "nl"].includes(e.lang), opened = A.countries[e.iso3] || 0;
    return h("article", { class: "page", style: `--bar:${bars[i % 3]}` },
      h("h3", null, e.name, h("small", { text: `${e.lang.toUpperCase()} · Google News health` })),
      h("p", { class: "why", text: `${opened ? `You touched ${e.name} only ${Math.round(opened)}× ` : `You opened nothing about ${e.name} `}in 90 days; ${p.reg || "this region"} is ${pct(A.regions[p.reg] || 0, tot)}% of your reading.` }),
      h("ul", null, e.items.slice(0, 6).map(it => h("li", null, link(it.title, it.url),
        h("span", null, [it.src, shortDate(it.date)].filter(Boolean).join(", "),
          foreign ? [" · ", link("translate", `https://translate.google.com/?sl=auto&tl=en&text=${encodeURIComponent(it.title)}&op=translate`)] : null)))));
  }) : [h("p", { class: "note", text: "The front pages have not loaded yet. They refresh every night." })]));
}

function renderCards() {
  const rnd = seeded("c" + new Date().toISOString().slice(0, 10));
  const cards = [];
  const unread = SHADOW.filter(c => !c.desk && c.line && !A.countries[c.iso3]);
  if (unread.length) {
    const c = unread[Math.floor(rnd() * unread.length)];
    cards.push(h("div", { class: "card" }, h("div", { class: "k", text: "A country you never open" }), h("h3", { text: c.name }),
      h("p", { text: c.line }), c.minister ? h("p", { class: "note", text: `Health: ${c.minister}` }) : null,
      h("p", null, link(`Open ${c.name} in Country Desk`, `../country-desk/all/#${c.slug}`))));
  }
  const skipped = TOPICS.slice().sort((a, b) => A.topics[a[0]] - A.topics[b[0]]);
  const all = (FRONT.editions || []).flatMap(e => e.items.map(it => ({ ...it, where: e.name })));
  for (const [t, test] of skipped) {
    const hits = all.filter(it => test(it.title)).slice(0, 5);
    if (!hits.length) continue;
    cards.push(h("div", { class: "card" }, h("div", { class: "k", text: "A topic you skip" }), h("h3", { text: t }),
      h("p", { text: A.topics[t] ? `Only ${A.topics[t]} of your clicks in 90 days touched this.` : "None of your clicks in 90 days touched this. Today's front pages do:" }),
      h("ul", null, hits.map(it => h("li", null, link(it.title, it.url), ` (${it.where})`)))));
    break;
  }
  const known = new Set(Object.keys(A.hosts).map(d => d.split(".").slice(-2, -1)[0]));
  const rim = edgeEditions().flatMap(p => p.e.items.map(it => ({ ...it, where: p.e.name })));
  const seen = new Set(), fresh = [];
  for (const it of rim) {
    const key = (it.src || "").toLowerCase();
    if (!key || seen.has(key) || [...known].some(k => k && key.replace(/\W/g, "").includes(k))) continue;
    seen.add(key); fresh.push(it);
  }
  if (fresh.length) cards.push(h("div", { class: "card" }, h("div", { class: "k", text: "Newsrooms you never click" }), h("h3", { text: `${fresh.length} new voices today` }),
    h("ul", null, fresh.slice(0, 6).map(it => h("li", null, h("b", { text: it.src }), " (", it.where, "): ", link(it.title, it.url))))));
  $("#cards").replaceChildren(...cards);
}

function forget(e) {
  const b = e.currentTarget;
  if (b.dataset.armed) {
    try { localStorage.removeItem(KEY); } catch (_) { /* nothing stored */ }
    location.reload();
  } else { b.dataset.armed = "1"; b.textContent = "Click again to forget everything"; setTimeout(() => { delete b.dataset.armed; b.textContent = "Forget my history"; }, 4000); }
}

boot();
})();
