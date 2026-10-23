// Crowd Forecasts — daily fetch of geopolitical prediction markets.
// Sources: Polymarket (Gamma API), Kalshi (public trade API), Manifold, Metaculus (needs METACULUS_TOKEN).
// Runs in GitHub Actions (Node 20+, no dependencies). Writes data/forecasts.json
// and keeps a 60-day probability history in data/history.json.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "data");
const OUT = join(DATA, "forecasts.json");
const HIST = join(DATA, "history.json");

const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);
const HORIZON_MS = 3 * 365 * 864e5; // ignore markets resolving more than 3 years out

const CAP = { polymarket: 80, kalshi: 50, manifold: 30, metaculus: 40 };

// ---------- themes ----------
const THEMES = {
  health: [
    /\bpandemic/i, /\boutbreak/i, /bird flu/i, /\bh5n1\b/i, /\bmeasles/i, /\bmpox/i, /\bebola/i,
    /\bmarburg/i, /\bcholera/i, /\bpolio/i, /\bcovid/i, /\bvaccin/i, /\bWHO\b/, /world health/i,
    /\bpheic\b/i, /public health emergency/i, /\bdengue/i, /\bdisease/i, /\bvirus\b/i,
  ],
  conflict: [
    /\bwar\b/i, /ceasefire/i, /cease-fire/i, /invade/i, /invasion/i, /military/i, /\bstrikes?\b/i,
    /\battack/i, /troops/i, /\bukrain/i, /\brussia/i, /\bputin/i, /zelensk/i, /\bisrael/i, /\bgaza/i,
    /\bhamas/i, /hezbollah/i, /\biran/i, /\btaiwan/i, /\bnato\b/i, /nuclear/i, /missile/i, /\bsudan/i,
    /houthi/i, /\bsyria/i, /north korea/i, /\bkim jong/i, /\bdrone/i, /\bcoup\b/i, /\bkashmir/i,
    /\bvenezuela/i, /\bhostage/i, /\bpeace deal/i, /\bpeace agreement/i, /\bcongo\b|\bdrc\b/i,
    /\bannex/i, /\bgreenland/i, /\bblockade/i,
  ],
  trade: [
    /tariff/i, /trade deal/i, /trade agreement/i, /sanction/i, /\btreaty/i, /\bsummit/i,
    /\bembargo/i, /\bwto\b/i, /\bg7\b/i, /\bg20\b/i, /\bbrics/i, /\bunited nations\b|\bu\.?n\.? (security|general)/i,
    /\bdiplomat/i, /\bmeets? (with )?(xi|putin|trump|zelensky|modi|kim)/i, /\brecogni[sz]e/i,
    /\beu\b.*\b(join|accession|membership)/i, /\bexport (ban|control)/i, /\bdeal with\b/i, /\bopec/i,
  ],
  elections: [
    /election/i, /\belected\b/i, /\bpresiden/i, /prime minister/i, /chancellor/i, /\bpm\b/i,
    /\bresign/i, /impeach/i, /\bout as\b/i, /\bparliament/i, /referendum/i, /coalition/i,
    /\bleader of\b/i, /\bnext leader/i, /\bremoved from office/i, /\bsnap election/i, /\bvote of no confidence/i,
    /\bpope\b/i, /\bsupreme leader/i, /\bmayor\b/i,
  ],
};

// Markets that are noise for a geopolitical overview.
const EXCLUDE = [
  /\b(nfl|nba|nhl|mlb|ufc|f1|formula 1|premier league|champions league|world cup|super bowl|olympic|tennis|golf|grand prix|match|playoffs?|stanley cup|world series)\b/i,
  /\b(bitcoin|btc|ethereum|eth|solana|crypto|token|memecoin|xrp|doge)\b/i,
  /\b(fed|fomc|interest rate|cpi|inflation|gdp|recession|s&p|nasdaq|dow|stock|ipo|earnings|unemployment)\b/i,
  /\b(oscar|grammy|emmy|box office|album|song|movie|netflix|spotify|taylor swift|kardashian)\b/i,
  /\b(say|said|mention|tweet|post on x|truth social|follower|podcast)\b/i,
  /\b(weather|temperature|hurricane|snow|rain|°)\b/i,
  /\b(elon|musk|openai|gpt|ai model|tesla|apple|google|microsoft)\b/i,
  /\b(approval rating|deport|ice raids?|epstein|doge)\b/i,
  /\b(aliens?|ufo|uap|margin of victory|popular vote margin|turnout|how many|mention)\b/i,
  /\[(polymarket|kalshi|metaculus)\]/i, /^if /i,
];

// Primary theme = first match in this order, so a war-related election or trade item
// is filed under elections/trade rather than conflict.
const THEME_ORDER = ["health", "trade", "elections", "conflict"];
function themesOf(text) {
  const t = String(text || "");
  return THEME_ORDER.filter((k) => THEMES[k].some((r) => r.test(t)));
}
// Balanced pick: round-robin over primary themes (each list already sorted by volume),
// so high-volume war markets can't crowd out elections, trade and health.
function balanced(items, cap) {
  const byTheme = new Map(THEME_ORDER.map((k) => [k, []]));
  for (const it of items) byTheme.get(it.themes[0])?.push(it);
  const out = [];
  while (out.length < cap && [...byTheme.values()].some((l) => l.length)) {
    for (const k of THEME_ORDER) { const l = byTheme.get(k); if (l.length && out.length < cap) out.push(l.shift()); }
  }
  return out;
}
const excluded = (text) => EXCLUDE.some((r) => r.test(String(text || "")));

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "crowd-forecasts/1.0 (github pages)" } });
      if (res.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
      return await res.json();
    } catch (e) { last = e; await sleep(800 * (i + 1)); }
  }
  throw last || new Error("fetch failed " + url);
}

const num = (v) => { const n = typeof v === "string" ? parseFloat(v) : v; return Number.isFinite(n) ? n : null; };
const isoDate = (d) => { if (!d) return null; const x = new Date(d); return isNaN(x) ? null : x.toISOString(); };
const clamp01 = (p) => (p == null ? null : Math.max(0, Math.min(1, p)));

const DATE_LABEL = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{0,2}\b|\b20\d\d\b|\bq[1-4]\b|\bby (end of|the end)/i;

// Turn a list of options into a normalized item.
function buildItem(base, options) {
  options = options.filter((o) => o.p != null);
  if (!options.length) return null;
  let kind = "binary", prob, lead = null, resolves;
  if (options.length === 1) {
    prob = options[0].p;
    resolves = options[0].end || base.end;
  } else {
    const dated = options.filter((o) => DATE_LABEL.test(o.label)).length;
    if (dated >= Math.ceil(options.length * 0.6)) {
      // "By date X?" ladder: each option is the same question with a later deadline.
      kind = "ladder";
      options.sort((a, b) => (a.end || "9").localeCompare(b.end || "9"));
      const next = options.find((o) => !o.end || new Date(o.end) > NOW) || options[options.length - 1];
      prob = next.p; lead = next.label; resolves = next.end || base.end;
    } else {
      kind = "multi";
      options.sort((a, b) => b.p - a.p);
      prob = options[0].p; lead = options[0].label;
      resolves = base.end || options.map((o) => o.end).filter(Boolean).sort().pop();
      options = options.slice(0, 6);
    }
  }
  if (resolves && new Date(resolves) - NOW > HORIZON_MS) return null;
  return {
    ...base, kind, prob: +prob.toFixed(3), lead,
    options: options.length > 1 ? options.map((o) => ({ label: o.label, p: +o.p.toFixed(3), end: o.end || null })) : [],
    resolves: resolves || null,
  };
}

// ---------- Polymarket ----------
async function polymarket() {
  const seen = new Map();
  const add = (evs) => { for (const e of evs || []) if (e && e.id && !seen.has(e.id)) seen.set(e.id, e); };
  const base = "https://gamma-api.polymarket.com/events?closed=false&active=true&archived=false&order=volume&ascending=false";
  for (const tag of ["geopolitics", "world", "elections", "politics", "global-elections", "trade", "health", "ukraine", "middle-east"]) {
    try { add(await getJSON(`${base}&limit=100&tag_slug=${tag}`)); } catch (e) { console.warn("polymarket tag", tag, e.message); }
    await sleep(250);
  }
  for (let offset = 0; offset < 500; offset += 100) {
    try { add(await getJSON(`${base}&limit=100&offset=${offset}`)); } catch (e) { console.warn("polymarket page", offset, e.message); break; }
    await sleep(250);
  }
  if (!seen.size) throw new Error("Polymarket returned nothing");

  const items = [];
  for (const e of seen.values()) {
    const tagText = (e.tags || []).map((t) => t.label || t.slug).join(" ");
    if (/\b(sports|crypto|pop culture|esports|tech)\b/i.test(tagText) && !/geopolitic|world|election/i.test(tagText)) continue;
    const text = `${e.title} ${e.description ? e.description.slice(0, 300) : ""}`;
    if (excluded(e.title)) continue;
    const themes = themesOf(`${e.title} ${tagText}`).length ? themesOf(`${e.title} ${tagText}`) : themesOf(text);
    if (!themes.length) continue;

    const markets = (e.markets || []).filter((m) => m && !m.closed && m.active !== false);
    const options = markets.map((m) => {
      let outcomes, prices;
      try { outcomes = JSON.parse(m.outcomes || "[]"); prices = JSON.parse(m.outcomePrices || "[]").map(num); } catch { return null; }
      const yi = outcomes.findIndex((o) => /^yes$/i.test(o));
      const p = clamp01(yi >= 0 ? prices[yi] : prices[0]);
      return { label: m.groupItemTitle || m.question || outcomes[0], p, end: isoDate(m.endDate), vol: num(m.volume) || 0 };
    }).filter(Boolean);
    // Drop placeholder options with no trading in multi-option events
    const useful = options.length > 1 ? options.filter((o) => o.vol > 0 || o.p > 0.005) : options;

    const item = buildItem({
      id: "pm-" + e.id, source: "polymarket", title: e.title,
      url: `https://polymarket.com/event/${e.slug}`,
      volume: Math.round(num(e.volume) || 0), volumeUnit: "usd",
      end: isoDate(e.endDate), themes,
    }, useful);
    if (item) items.push(item);
  }
  return balanced(items.sort((a, b) => b.volume - a.volume), CAP.polymarket);
}

// ---------- Kalshi ----------
async function kalshi() {
  const hosts = ["https://api.elections.kalshi.com/trade-api/v2", "https://external-api.kalshi.com/trade-api/v2"];
  let host = null, events = [];
  for (const h of hosts) {
    try { await getJSON(`${h}/events?limit=1&status=open`, 1); host = h; break; } catch (e) { console.warn("kalshi host", h, e.message); }
  }
  if (!host) throw new Error("Kalshi unreachable");
  let cursor = "";
  for (let page = 0; page < 25; page++) {
    const j = await getJSON(`${host}/events?status=open&with_nested_markets=true&limit=200${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
    events.push(...(j.events || []));
    cursor = j.cursor;
    if (!cursor) break;
    await sleep(300);
  }
  const OK_CAT = /world|politic|election|health|geopolit|international/i;
  const items = [];
  for (const e of events) {
    if (e.category && !OK_CAT.test(e.category)) continue;
    const title = e.title || "";
    if (excluded(title)) continue;
    const themes = themesOf(`${title} ${e.sub_title || ""}`);
    if (!themes.length) continue;
    const markets = (e.markets || []).filter((m) => !m.status || /active|open|initialized/i.test(m.status));
    let vol = 0;
    const options = markets.map((m) => {
      const p = clamp01(
        num(m.last_price_dollars) ?? (num(m.last_price) != null ? num(m.last_price) / 100 : null) ??
        num(m.yes_bid_dollars) ?? (num(m.yes_bid) != null ? num(m.yes_bid) / 100 : null)
      );
      vol += num(m.volume_fp) ?? num(m.volume) ?? 0;
      const label = m.yes_sub_title || m.subtitle || m.title || title;
      return { label, p, end: isoDate(m.expected_expiration_time || m.close_time) };
    });
    if (!vol) continue;
    const useful = options.length > 1 ? options.filter((o) => o.p != null && o.p > 0.005) : options;
    const series = (e.series_ticker || e.event_ticker || "").toLowerCase();
    const item = buildItem({
      id: "ks-" + e.event_ticker, source: "kalshi", title: e.sub_title && e.sub_title.length <= 40 && !title.includes(e.sub_title) ? `${title} (${e.sub_title})` : title,
      url: `https://kalshi.com/markets/${series}`,
      volume: Math.round(vol), volumeUnit: "contracts",
      end: null, themes,
    }, useful);
    if (item) items.push(item);
  }
  return balanced(items.sort((a, b) => b.volume - a.volume), CAP.kalshi);
}

// ---------- Manifold ----------
async function manifold() {
  const terms = ["ukraine", "russia", "ceasefire", "israel", "iran", "taiwan", "china", "nato", "war", "election",
    "prime minister", "president", "tariff", "sanctions", "pandemic", "H5N1", "WHO", "nuclear", "gaza", "coup", "venezuela", "india pakistan"];
  const seen = new Map();
  for (const t of terms) {
    try {
      const res = await getJSON(`https://api.manifold.markets/v0/search-markets?term=${encodeURIComponent(t)}&filter=open&sort=most-popular&contractType=BINARY&limit=40`);
      for (const m of res || []) if (!seen.has(m.id)) seen.set(m.id, m);
    } catch (e) { console.warn("manifold", t, e.message); }
    await sleep(200);
  }
  if (!seen.size) throw new Error("Manifold returned nothing");
  const items = [];
  for (const m of seen.values()) {
    if (m.outcomeType !== "BINARY" || m.isResolved) continue;
    if ((m.uniqueBettorCount || 0) < 40) continue;
    if (excluded(m.question)) continue;
    const themes = themesOf(m.question);
    if (!themes.length) continue;
    const item = buildItem({
      id: "mf-" + m.id, source: "manifold", title: m.question, url: m.url,
      volume: m.uniqueBettorCount || 0, volumeUnit: "traders", end: null, themes,
    }, [{ label: "Yes", p: clamp01(num(m.probability)), end: isoDate(m.closeTime) }]);
    if (item) items.push(item);
  }
  return balanced(items.sort((a, b) => b.volume - a.volume), CAP.manifold);
}

const META_STATS = {};
// ---------- Metaculus (requires a free API token in env METACULUS_TOKEN) ----------
async function metaculus() {
  const token = process.env.METACULUS_TOKEN;
  if (!token) throw new Error("SKIP: no METACULUS_TOKEN secret set");
  const headers = { accept: "application/json", authorization: `Token ${token}`, "user-agent": "crowd-forecasts/1.0 (github pages)" };
  const get = async (url) => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(url, { headers });
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue; }
      if (res.status === 401 || res.status === 403) throw new Error(`Metaculus auth failed (${res.status}): check the METACULUS_TOKEN secret`);
      if (!res.ok) throw new Error(`${res.status} for ${url}`);
      return res.json();
    }
    throw new Error("Metaculus rate limited");
  };
  const base = "https://www.metaculus.com/api/posts/?statuses=open&with_cp=true&limit=100&order_by=-nr_forecasters";
  const seen = new Map();
  const add = (j) => { for (const p of (j && (j.results || j)) || []) if (p && p.id && !seen.has(p.id)) seen.set(p.id, p); };
  for (const cat of ["geopolitics", "elections", "health-pandemics", "politics", "economy-business"]) {
    try { add(await get(`${base}&categories=${cat}`)); } catch (e) { if (/auth/.test(e.message)) throw e; console.warn("metaculus cat", cat, e.message); }
    await sleep(600);
  }
  for (const term of ["Ukraine", "Russia", "Taiwan", "China", "Iran", "Israel", "NATO", "ceasefire", "election", "tariff", "pandemic", "H5N1", "WHO", "nuclear war"]) {
    try { add(await get(`${base}&search=${encodeURIComponent(term)}`)); } catch (e) { if (/auth/.test(e.message)) throw e; console.warn("metaculus term", term, e.message); }
    await sleep(600);
  }
  if (!seen.size) throw new Error("Metaculus returned nothing");

  const latestOf = (q) => {
    const agg = q && q.aggregations && (q.aggregations.recency_weighted || q.aggregations.unweighted);
    return agg && (agg.latest || (agg.history && agg.history[agg.history.length - 1]));
  };
  const items = [];
  META_STATS.fetched = seen.size; META_STATS.skipped = {};
  const skip = (why) => { META_STATS.skipped[why] = (META_STATS.skipped[why] || 0) + 1; };
  for (const p of seen.values()) {
    const q = p.question;
    if (!q) { skip(p.group_of_questions ? "group" : p.conditional ? "conditional" : p.notebook ? "notebook" : "other"); continue; }
    if ((p.nr_forecasters || 0) < 25) { skip("few forecasters"); continue; }
    const title = p.title || q.title;
    if (excluded(title)) { skip("excluded topic"); continue; }
    const themes = themesOf(title);
    if (!themes.length) { skip("no theme match"); if ((META_STATS.sampleNoTheme ||= []).length < 12) META_STATS.sampleNoTheme.push(title); continue; }
    const latest = latestOf(q);
    if (!latest) { skip("no community prediction"); if (!META_STATS.sampleKeys) META_STATS.sampleKeys = { post: Object.keys(p), question: Object.keys(q), agg: q.aggregations ? Object.keys(q.aggregations) : null }; continue; }
    const end = isoDate(q.scheduled_resolve_time || p.scheduled_resolve_time);
    let options;
    if (q.type === "binary") {
      const p1 = Array.isArray(latest.centers) ? latest.centers[0] : Array.isArray(latest.forecast_values) ? latest.forecast_values[1] : null;
      options = [{ label: "Yes", p: clamp01(num(p1)), end }];
    } else if (q.type === "multiple_choice" && Array.isArray(q.options) && Array.isArray(latest.forecast_values)) {
      options = q.options.map((o, i) => ({ label: o, p: clamp01(num(latest.forecast_values[i])), end }));
    } else { skip(q.type || "unknown"); continue; }
    const item = buildItem({
      id: "mc-" + p.id, source: "metaculus", title,
      url: `https://www.metaculus.com/questions/${p.id}/${p.slug || ""}`,
      volume: p.nr_forecasters || 0, volumeUnit: "forecasters", end, themes,
    }, options);
    if (item) items.push(item); else skip("beyond 3 years");
  }
  return balanced(items.sort((a, b) => b.volume - a.volume), CAP.metaculus);
}

// ---------- main ----------
async function readJSON(p, fallback) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; } }

async function main() {
  await mkdir(DATA, { recursive: true });
  const prev = await readJSON(OUT, { items: [], sources: {} });
  const history = await readJSON(HIST, {});
  const sources = {};
  let items = [];

  for (const [name, fn] of [["polymarket", polymarket], ["kalshi", kalshi], ["manifold", manifold], ["metaculus", metaculus]]) {
    try {
      const got = await fn();
      items.push(...got);
      sources[name] = { ok: true, count: got.length, updated: NOW.toISOString() };
      if (name === "metaculus") sources[name].stats = META_STATS;
      console.log(`${name}: ${got.length} items`);
    } catch (e) {
      if (/^SKIP/.test(e.message)) { console.log(`${name} skipped: ${e.message}`); sources[name] = { ok: false, count: 0, updated: null, error: e.message.replace(/^SKIP: /, "") }; continue; }
      console.error(`${name} failed:`, e.message);
      const old = (prev.items || []).filter((i) => i.source === name);
      items.push(...old);
      sources[name] = { ok: false, count: old.length, updated: prev.sources?.[name]?.updated || null, error: e.message };
    }
  }

  // History + 1-day / 7-day change
  for (const it of items) {
    const h = (history[it.id] ||= []);
    if (!h.length || h[h.length - 1][0] !== TODAY) h.push([TODAY, it.prob]);
    else h[h.length - 1][1] = it.prob;
    const ago = (days) => {
      const cutoff = new Date(NOW - days * 864e5).toISOString().slice(0, 10);
      const older = h.filter(([d]) => d <= cutoff);
      return older.length ? older[older.length - 1][1] : null;
    };
    const p1 = ago(1), p7 = ago(7);
    it.d1 = p1 == null ? null : +(it.prob - p1).toFixed(3);
    it.d7 = p7 == null ? null : +(it.prob - p7).toFixed(3);
    it.spark = h.slice(-30).map(([, p]) => p);
  }
  const keepFrom = new Date(NOW - 60 * 864e5).toISOString().slice(0, 10);
  const live = new Set(items.map((i) => i.id));
  for (const id of Object.keys(history)) {
    history[id] = history[id].filter(([d]) => d >= keepFrom);
    if (!history[id].length || (!live.has(id) && history[id][history[id].length - 1][0] < keepFrom)) delete history[id];
  }

  // Drop markets whose deadline passed more than a week ago (resolved but not yet closed)
  const stale = new Date(NOW - 7 * 864e5).toISOString();
  items = items.filter((i) => !i.resolves || i.resolves >= stale);
  items.sort((a, b) => (a.resolves || "9999").localeCompare(b.resolves || "9999"));
  if (!items.length) throw new Error("No items from any source — keeping previous file");

  await writeFile(OUT, JSON.stringify({ generated: NOW.toISOString(), sources, items }, null, 1));
  await writeFile(HIST, JSON.stringify(history));
  console.log(`wrote ${items.length} items`);
}

main().catch((e) => { console.error(e); process.exit(1); });
