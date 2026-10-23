// Crowd Forecasts — daily fetch of geopolitical prediction markets.
// Sources: Polymarket (Gamma API), Kalshi (public trade API), Manifold, Metaculus (needs METACULUS_TOKEN),
// PredictIt (public API, non-commercial licence, max 1 request/minute) and Smarkets (best effort).
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

const CAP = { polymarket: 80, kalshi: 50, manifold: 30, metaculus: 40, predictit: 25, smarkets: 25 };

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
    /\bannex/i, /\bgreenland/i, /\bblockade/i, /\bhormuz/i, /\bstrait of/i, /\bcuba/i, /\bpakistan/i, /\bafghanistan/i,
    /\bsecede|secession|independence/i, /\barms control/i, /\bsaudi/i, /\bturkey|t[uü]rkiye/i, /\bmilitary/i, /\bregime/i, /\bgenocide/i, /\bterror/i,
  ],
  trade: [
    /tariff/i, /trade deal/i, /trade agreement/i, /sanction/i, /\btreaty/i, /\bsummit/i,
    /\bembargo/i, /\bwto\b/i, /\bg7\b/i, /\bg20\b/i, /\bbrics/i, /\bunited nations\b|\bu\.?n\.? (security|general)/i,
    /\bdiplomat/i, /\bmeets? (with )?(xi|putin|trump|zelensky|modi|kim)/i, /\brecogni[sz]e/i,
    /\bimf\b|\bworld bank/i, /\bstabili[sz]ation facility/i, /\bbailout/i, /\beuro(zone)?\b/i, /\bde-?dollari[sz]/i,
    /\beu\b.*\b(join|accession|membership)/i, /\bexport (ban|control)/i, /\bdeal with\b/i, /\bopec/i,
  ],
  elections: [
    /election/i, /\belected\b/i, /\bpresiden/i, /prime minister/i, /chancellor/i, /\bpm\b/i,
    /\bresign/i, /impeach/i, /\bout as\b/i, /\bparliament/i, /referendum/i, /coalition/i,
    /\bleader of\b/i, /\bnext leader/i, /\bremoved from office/i, /\bsnap election/i, /\bvote of no confidence/i,
    /\bpope\b/i, /\bsupreme leader/i, /\bmayor\b/i, /\bmidterm/i, /\bgovernment\b/i, /\bdemocra/i, /\bhouse of representatives|\bsenate\b|\bcongress\b/i,
    /\blose power/i, /\bleave the (eu|uk|european union)/i, /\bnext (german|french|dutch|uk|us) /i, /\bnominee/i,
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
  const items = [], pending = [];
  META_STATS.fetched = seen.size; META_STATS.skipped = {};
  const skip = (why) => { META_STATS.skipped[why] = (META_STATS.skipped[why] || 0) + 1; };
  for (const p of seen.values()) {
    const q = p.question;
    if (!q) {
      skip(p.group_of_questions ? "group" : p.conditional ? "conditional" : p.notebook ? "notebook" : "other");
      if (p.group_of_questions && !META_STATS.sampleGroup) {
        const g = p.group_of_questions, sq = (g.questions || [])[0];
        META_STATS.sampleGroup = { title: p.title, keys: Object.keys(g), nQuestions: (g.questions || []).length, subKeys: sq ? Object.keys(sq) : null,
          subSample: sq ? { label: sq.label, type: sq.type, hasAgg: !!(sq.aggregations && sq.aggregations.recency_weighted), latestKeys: sq.aggregations?.recency_weighted?.latest ? Object.keys(sq.aggregations.recency_weighted.latest) : null } : null };
      }
      continue;
    }
    if ((p.nr_forecasters || 0) < 10) { skip("few forecasters"); continue; }
    const title = p.title || q.title;
    if (excluded(title)) { skip("excluded topic"); continue; }
    const themes = themesOf(title);
    if (!themes.length) { skip("no theme match"); if ((META_STATS.sampleNoTheme ||= []).length < 12) META_STATS.sampleNoTheme.push(title); continue; }
    const latest = latestOf(q);
    if (latest && !META_STATS.sampleOK) META_STATS.sampleOK = { title, type: q.type, latestKeys: Object.keys(latest), cp_reveal_time: q.cp_reveal_time };
    if (!latest) {
      if (pending.length < 12) pending.push({ p, title, themes }); else skip("no community prediction");
      continue;
    }
    emit(p, q, latest, title, themes);
  }

  // Second chance: the list endpoint withholds the community prediction for many questions.
  // Ask for each question's own page instead (rate-limited, newest/most-forecast first).
  pending.sort((a, b) => (b.p.nr_forecasters || 0) - (a.p.nr_forecasters || 0));
  META_STATS.detailTried = 0; META_STATS.detailGot = 0; META_STATS.detailSamples = [];
  for (const { p, title, themes } of pending) {
    let d = null;
    try { d = await get(`https://www.metaculus.com/api/posts/${p.id}/`); } catch (e) { META_STATS.detailError = e.message; }
    META_STATS.detailTried++;
    const dq = d && d.question;
    const latest = dq && latestOf(dq);
    if (META_STATS.detailSamples.length < 3 && d) {
      const rw = dq && dq.aggregations && dq.aggregations.recency_weighted;
      META_STATS.detailSamples.push({ title, topKeys: Object.keys(d).slice(0, 40), aggKeys: dq && dq.aggregations ? Object.keys(dq.aggregations) : null, rwKeys: rw ? Object.keys(rw) : null, hasLatest: !!latest });
    }
    if (latest) { META_STATS.detailGot++; emit(d, dq, latest, title, themes); } else skip("no community prediction");
    await sleep(700);
  }
  return balanced(items.sort((a, b) => b.volume - a.volume), CAP.metaculus);

  function emit(p, q, latest, title, themes) {
    const end = isoDate(q.scheduled_resolve_time || p.scheduled_resolve_time);
    let options;
    if (q.type === "binary") {
      const p1 = Array.isArray(latest.centers) ? latest.centers[0] : Array.isArray(latest.forecast_values) ? latest.forecast_values[1] : null;
      options = [{ label: "Yes", p: clamp01(num(p1)), end }];
    } else if (q.type === "multiple_choice" && Array.isArray(q.options) && Array.isArray(latest.forecast_values)) {
      options = q.options.map((o, i) => ({ label: o, p: clamp01(num(latest.forecast_values[i])), end }));
    } else { skip(q.type || "unknown"); return; }
    const item = buildItem({
      id: "mc-" + p.id, source: "metaculus", title,
      url: `https://www.metaculus.com/questions/${p.id}/${p.slug || ""}`,
      volume: p.nr_forecasters || 0, volumeUnit: "forecasters", end, themes,
    }, options);
    if (item) items.push(item); else skip("beyond 3 years");
  }
}

// ---------- PredictIt (public API, US politics; non-commercial licence, 1 request/minute) ----------
async function predictit() {
  const j = await getJSON("https://www.predictit.org/api/marketdata/all/");
  const items = [];
  for (const m of j.markets || []) {
    if (m.status && !/open/i.test(m.status)) continue;
    const title = m.name || m.shortName || "";
    if (excluded(title)) continue;
    const themes = themesOf(title);
    if (!themes.length) continue;
    const cs = (m.contracts || []).filter((c) => !c.status || /open/i.test(c.status));
    const price = (c) => clamp01(num(c.lastTradePrice) ?? num(c.bestBuyYesCost));
    const dateOf = (c) => (c.dateEnd && c.dateEnd !== "NA" ? isoDate(c.dateEnd) : null);
    const options = cs.map((c) => ({ label: c.shortName || c.name, p: price(c), end: dateOf(c) }))
      .filter((o) => o.p != null && (cs.length === 1 || o.p > 0.01));
    const item = buildItem({
      id: "pi-" + m.id, source: "predictit", title, url: m.url || `https://www.predictit.org/markets/detail/${m.id}`,
      volume: 0, volumeUnit: "", end: cs.map(dateOf).filter(Boolean).sort().pop() || null, themes,
    }, options);
    if (item) items.push(item);
  }
  items.sort((a, b) => (a.resolves || "9").localeCompare(b.resolves || "9"));
  return balanced(items, CAP.predictit);
}

const SM_STATS = { sample: [], quoteSample: [], dropped: 0 };
// ---------- Smarkets (UK betting exchange; best effort, public read endpoints) ----------
async function smarkets() {
  const base = "https://api.smarkets.com/v3";
  const ev = await getJSON(`${base}/events/?state=upcoming&state=live&type_domain=politics&limit=200&sort=id`, 2);
  const events = (ev.events || []).filter((e) => !excluded(e.name) && themesOf(e.name).length && e.name.trim().split(/\s+/).length >= 3).slice(0, 60);
  if (!events.length) throw new Error("Smarkets returned no matching events");
  const items = [];
  for (const e of events) {
    try {
      const mk = (await getJSON(`${base}/events/${e.id}/markets/`, 1)).markets || [];
      if (!mk.length) continue;
      const ids = mk.map((m) => m.id).join(",");
      const contracts = (await getJSON(`${base}/markets/${ids}/contracts/`, 1)).contracts || [];
      // pick the market with the most contracts (usually "Winner")
      const byMarket = new Map();
      for (const c of contracts) { if (!byMarket.has(c.market_id)) byMarket.set(c.market_id, []); byMarket.get(c.market_id).push(c); }
      const [mid, cs] = [...byMarket.entries()].sort((a, b) => b[1].length - a[1].length)[0] || [];
      if (!mid) continue;
      // Stricter pricing: mid of best bid and best offer, and only where the spread is tight.
      // (Last-traded prices can be hours or days old on thin contracts.)
      const qr = await getJSON(`${base}/markets/${mid}/quotes/`, 1);
      const quotes = qr.quotes || qr;
      const sample = Object.entries(quotes).slice(0, 2).map(([k, v]) => ({ event: e.name, contract: k, bids: (v.bids || []).slice(0, 2), offers: (v.offers || []).slice(0, 2) }));
      for (const x of sample) if (SM_STATS.quoteSample.length < 6) SM_STATS.quoteSample.push(x);
      const allPrices = Object.values(quotes).flatMap((v) => [...(v.bids || []), ...(v.offers || [])]).map((x) => num(x.price)).filter((x) => x != null);
      const scale = allPrices.length && Math.max(...allPrices) <= 100 ? 100 : 10000; // percent or basis points
      const MAX_SPREAD = 0.05;
      const mids = new Map();
      for (const c of cs) {
        const q = quotes[String(c.id)] || {};
        const bids = (q.bids || []).map((x) => num(x.price) / scale).filter((x) => Number.isFinite(x));
        const offers = (q.offers || []).map((x) => num(x.price) / scale).filter((x) => Number.isFinite(x));
        if (!bids.length || !offers.length) continue;
        const bid = Math.max(...bids), offer = Math.min(...offers);
        if (offer < bid || offer - bid > MAX_SPREAD) continue;
        mids.set(String(c.id), clamp01((bid + offer) / 2));
      }
      let options = cs.map((c) => ({ label: c.name, p: mids.get(String(c.id)), end: null }));
      const yes = options.find((o) => /^yes$/i.test(o.label)), no = options.find((o) => /^no$/i.test(o.label));
      if (options.length === 2 && yes && no) options = yes.p != null ? [{ label: "Yes", p: yes.p, end: null }] : [];
      else options = options.filter((o) => o.p != null && o.p > 0.01);
      if (!options.length) { SM_STATS.dropped++; continue; }
      const item = buildItem({
        id: "sm-" + e.id, source: "smarkets", title: e.name, url: `https://smarkets.com/event/${e.id}${e.full_slug || ""}`,
        volume: 0, volumeUnit: "", end: isoDate(e.start_datetime), themes: themesOf(e.name),
      }, options);
      if (item) items.push(item);
    } catch (err) { console.warn("smarkets event", e.id, err.message); }
    await sleep(300);
  }
  if (!items.length) throw new Error("Smarkets gave no usable prices");
  return balanced(items, CAP.smarkets);
}

// ---------- main ----------
async function readJSON(p, fallback) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; } }

async function main() {
  await mkdir(DATA, { recursive: true });
  const prev = await readJSON(OUT, { items: [], sources: {} });
  const history = await readJSON(HIST, {});
  const sources = {};
  let items = [];

  for (const [name, fn] of [["polymarket", polymarket], ["kalshi", kalshi], ["manifold", manifold], ["metaculus", metaculus], ["predictit", predictit], ["smarkets", smarkets]]) {
    try {
      const got = await fn();
      items.push(...got);
      sources[name] = { ok: true, count: got.length, updated: NOW.toISOString() };
      if (name === "metaculus") sources[name].stats = META_STATS;
      if (name === "smarkets") sources[name].stats = SM_STATS;
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
