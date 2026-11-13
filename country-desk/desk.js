/* Country Desk. One script for the map page and the country pages.
   A country page is <body data-slug="kenya">; the map page has no data-slug. */
(() => {
"use strict";
const slug = document.body.dataset.slug || "";
const BASE = slug ? "../" : "./";
const $ = s => document.querySelector(s);

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
const link = (text, url, cls) => url ? h("a", { href: url, class: cls, rel: "noopener" }, text) : h("span", { class: cls }, text);
const getJSON = (p, fallback) => fetch(BASE + p, { cache: "no-cache" }).then(r => r.ok ? r.json() : fallback).catch(() => fallback);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const today = () => new Date().toISOString().slice(0, 10);
function shortDate(iso) { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]}` + (y !== new Date().getFullYear() ? ` ${y}` : ""); }
function fmtNum(v) {
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(v >= 1e10 ? 0 : 1) + " billion";
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + " million";
  if (Math.abs(v) >= 100) return Math.round(v).toLocaleString("en-GB");
  return (Math.round(v * 10) / 10).toLocaleString("en-GB");
}

/* ----- time ----- */
function zoneOffsetMin(tz, at) {          // minutes ahead of UTC at a given moment
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
    .formatToParts(at).filter(x => x.type !== "literal").map(x => [x.type, +x.value]));
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - at.getTime()) / 60000);
}
const clockText = (tz, at) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
const dayText = (tz, at) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(at);
function aheadText(diffMin, homeCity) {
  if (!diffMin) return `Same time as ${homeCity}`;
  const a = Math.abs(diffMin), hrs = Math.floor(a / 60), min = a % 60;
  const amount = [hrs ? `${hrs} hour${hrs > 1 ? "s" : ""}` : "", min ? `${min} minutes` : ""].filter(Boolean).join(" ");
  return `${amount} ${diffMin > 0 ? "ahead of" : "behind"} ${homeCity}`;
}
function overlapText(diffMin, homeCity) {   // shared 09:00-17:00 office hours, in home time
  const start = Math.max(9 * 60, 9 * 60 - diffMin), end = Math.min(17 * 60, 17 * 60 - diffMin);
  const f = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return end - start >= 30 ? `Shared office hours: ${f(start)} to ${f(end)} in ${homeCity}` : `No shared office hours with ${homeCity}; plan calls early or late`;
}

/* =================== map page =================== */
async function renderMap() {
  const [cfg, index, status] = await Promise.all([getJSON("data/countries.json", null), getJSON("data/index.json", { countries: [] }), getJSON("data/status.json", {})]);
  if (!cfg) { $("#desks").append(h("li", { class: "empty", text: "The country list could not be loaded. Reload the page to try again." })); return; }
  const home = cfg.home, byNum = Object.fromEntries(cfg.countries.map(c => [c.num, c])), info = Object.fromEntries(index.countries.map(c => [c.slug, c]));

  const tick = () => {
    const now = new Date();
    $("#homeclock").replaceChildren(h("b", { text: clockText(home.tz, now) }), `${home.city}, ${dayText(home.tz, now)}`);
    for (const c of cfg.countries) { const el = document.getElementById("t-" + c.slug); if (el) el.textContent = clockText(c.tz, now); }
  };

  const list = $("#desks");
  for (const c of cfg.countries) {
    const i = info[c.slug] || {};
    list.append(h("li", { style: `--spot:${c.ink}` }, h("a", { href: c.slug + "/" },
      h("span", { class: "name" }, h("i"), c.name),
      h("span", { class: "time num", id: "t-" + c.slug }),
      h("span", { class: "top" }, i.top || "No highlights yet", i.minister ? h("span", { text: `Health: ${i.minister}` }) : null),
      h("span", { class: "counts" }, `${i.news || 0} headlines, ${i.projects || 0} projects` + (i.outbreaks ? `, ${i.outbreaks} outbreak notice${i.outbreaks > 1 ? "s" : ""}` : "")))));
  }
  tick(); setInterval(tick, 20000);
  if (status.generated) $("#updated").textContent = `Data updated ${shortDate(status.generated.slice(0, 10))}. Highlights are written by Claude twice a week from the headlines linked on each page.`;

  try {
    const world = await getJSON("../nphi-map/lib/countries-110m.json", null);
    if (!world || !window.d3 || !window.topojson) throw new Error("map library missing");
    const W = 1100, H = 560, svg = d3.select("#map").append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img")
      .attr("aria-label", "World map with the countries highlighted; each one links to its country page");
    const feats = topojson.feature(world, world.objects.countries).features.filter(f => f.id !== "010");
    const proj = d3.geoNaturalEarth1().rotate([-20, 0]).fitExtent([[8, 8], [W - 8, H - 8]], { type: "FeatureCollection", features: feats });
    const path = d3.geoPath(proj);
    svg.append("g").selectAll("path").data(feats.filter(f => !byNum[f.id])).join("path")
      .attr("class", f => f.id === home.num ? "land home" : "land").attr("d", path);
    const g = svg.append("g");
    const hp = proj([home.lon, home.lat]);
    for (const c of cfg.countries) {
      const interp = d3.geoInterpolate([home.lon, home.lat], [c.lon, c.lat]);
      g.append("path").attr("class", "arc").attr("stroke", c.ink)
        .attr("d", path({ type: "LineString", coordinates: d3.range(0, 1.0001, 0.04).map(interp) }));
    }
    const links = feats.filter(f => byNum[f.id]).map(f => ({ f, c: byNum[f.id] }));
    for (const { f, c } of links)
      g.append("a").attr("href", c.slug + "/").attr("aria-label", c.name).append("path").attr("class", "desk").attr("fill", c.ink).attr("d", path(f));
    for (const c of cfg.countries) {      // pins and names go on top of every country shape
      const noShape = !links.some(l => l.c === c);      // city-states are too small for the 110m map: pin only
      const a = g.append("a").attr("href", c.slug + "/"), p = proj([c.lon, c.lat]);
      if (noShape) a.attr("aria-label", c.name); else a.attr("tabindex", -1).attr("aria-hidden", "true");
      a.append("circle").attr("class", "pin").attr("fill", c.ink).attr("cx", p[0]).attr("cy", p[1]).attr("r", noShape ? 6 : 4.5);
      const left = ["CO", "CA", "UG", "IN", "SG", "GB", "MY", "FR", "ES", "KR"].includes(c.iso2), up = ["ET", "CN", "MY"].includes(c.iso2);
      a.append("text").attr("x", p[0] + (left ? -9 : 9)).attr("y", p[1] + (up ? -8 : 4)).attr("text-anchor", left ? "end" : "start").text(c.name);
    }
    g.append("circle").attr("cx", hp[0]).attr("cy", hp[1]).attr("r", 4).attr("fill", "var(--ink)");
    g.append("text").attr("x", hp[0] - 8).attr("y", hp[1] - 8).attr("text-anchor", "end").text(home.city);
  } catch (e) {
    $("#map").append(h("p", { class: "empty", text: "The map could not be drawn here. The list below links to every country page." }));
  }
}

/* =================== country page =================== */
function section(id, title, lede, ...body) {
  return h("section", { id }, h("h2", { text: title }), lede ? h("p", { class: "lede", text: lede }) : null, ...body);
}
function sourceLinks(srcs) {
  return h("p", { class: "srcs" }, (srcs || []).map(s => link(s.t || s.src || s.title || "Source", s.u || s.url)));
}
function expandable(rows, first, render, noun) {
  const ul = h("ul", { class: "plist" }, rows.slice(0, first).map(render));
  if (rows.length <= first) return [ul];
  const btn = h("button", { class: "more", type: "button", text: `Show all ${rows.length} ${noun}`, onclick: () => { ul.append(...rows.slice(first).map(render)); btn.remove(); } });
  return [ul, btn];
}

async function renderCountry() {
  const [cfg, profile, live, status] = await Promise.all([getJSON("data/countries.json", null), getJSON(`data/profile/${slug}.json`, {}), getJSON(`data/live/${slug}.json`, {}), getJSON("data/status.json", {})]);
  const c = cfg && cfg.countries.find(x => x.slug === slug);
  const root = $("#desk");
  if (!c) { root.append(h("p", { class: "empty", text: "This country page could not be loaded. Reload to try again." })); return; }
  const home = cfg.home;
  document.documentElement.style.setProperty("--spot", c.ink);
  document.title = `${c.name} | Country Desk`;

  /* header */
  const clock = h("div", { class: "clock", "aria-live": "off" });
  const weather = h("span");
  const tick = () => {
    const now = new Date(), diff = zoneOffsetMin(c.tz, now) - zoneOffsetMin(home.tz, now);
    clock.replaceChildren(h("div", { class: "t", text: clockText(c.tz, now) }), h("div", { class: "d", text: `${c.capital}, ${dayText(c.tz, now)}` }),
      h("div", { class: "o" }, aheadText(diff, home.city), h("br"), overlapText(diff, home.city), h("br"), weather));
  };
  tick(); setInterval(tick, 20000);
  fetch(`https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}&current=temperature_2m,precipitation`)
    .then(r => r.json()).then(w => { if (w.current) weather.textContent = `${Math.round(w.current.temperature_2m)} °C in ${c.capital} now` + (w.current.precipitation > 0 ? ", raining" : ""); }).catch(() => {});

  const nav = [["highlights", "Highlights"], ["agenda", "Government agenda"], ["projects", "Projects"], ["calendar", "Calendar"], ["alerts", "Outbreaks and risk"], ["numbers", "Numbers"], ["headlines", "Headlines"]];
  root.append(
    h("a", { class: "back", href: "../" }, "All countries"),
    h("header", { class: "head" }, h("div", null, h("h1", { text: c.name }), h("p", { class: "sub", text: profile.snapshot || c.who })), clock),
    h("ul", { class: "who" }, (profile.leadership || []).map(p => h("li", null, h("div", { class: "role", text: p.role }),
      h("div", { class: "nm" }, link(p.name, p.src)), p.note ? h("div", { class: "small muted", text: p.note }) : null))),
    h("ul", { class: "jump" }, nav.map(([id, t]) => h("li", null, h("a", { href: "#" + id, text: t })))));

  /* highlights */
  const dg = live.digest || {};
  const hlBody = (dg.highlights || []).length
    ? [h("ol", { class: "hl" }, dg.highlights.map(x => h("li", null, h("h3", { text: x.headline }), x.why ? h("p", { text: x.why }) : null, sourceLinks(x.sources)))),
       dg.watch ? h("p", { class: "watch" }, h("b", { text: "Watch next: " }), dg.watch) : null]
    : [h("p", { class: "empty", text: "No highlights yet. They appear after the next twice-weekly digest; the headlines below are already current." })];
  const highlights = section("highlights", "Highlights", dg.date ? `What mattered in the past days, digest of ${shortDate(dg.date)}. Each point links to the reporting it rests on.` : "", ...hlBody);

  /* government agenda */
  const moves = live.moves || [];
  const agenda = section("agenda", "What the government is doing on health",
    profile.checked ? `Standing priorities, checked ${shortDate(profile.checked)}, and the latest concrete moves picked up from the news.` : "",
    (profile.agenda || []).length ? h("div", { class: "agenda" }, profile.agenda.map(a => h("article", null, h("h3", { text: a.title }), h("p", { text: a.text }), sourceLinks(a.src))))
      : h("p", { class: "empty", text: "No standing priorities recorded yet." }),
    moves.length ? h("h3", { class: "sub", text: "Latest moves" }) : null,
    moves.length ? h("ul", { class: "moves" }, moves.map(m => h("li", null, h("time", { datetime: m.date, text: shortDate(m.date) }), h("span", null, m.what + " ", link(m.src || "Source", m.url, "small muted"))))) : null);

  /* projects */
  const nlItems = (profile.nl || {}).items || [];
  const nphi = live.nphi || [], nphiNL = nphi.filter(p => p.nl), nphiOther = nphi.filter(p => !p.nl);
  const renderNphi = p => h("li", null, h("div", { class: "pt" }, link(p.title, p.url)),
    h("div", { class: "pm", text: [p.actor + (p.actorCountry ? ` (${p.actorCountry})` : ""), p.type, [p.start, p.end].filter(Boolean).join(" to "), p.status].filter(Boolean).join(", ") }),
    p.summary ? h("div", { class: "ps", text: p.summary }) : null);
  const wb = live.wbProjects || [];
  const projects = section("projects", "Projects and partnerships",
    "Dutch links first, then what other public health institutes are doing here, then active World Bank health projects.",
    h("div", { class: "pgroup" }, h("h3", null, "Dutch links", h("span", { text: `${nlItems.length + nphiNL.length} found` })),
      (profile.nl || {}).text ? h("p", { class: "ps", text: profile.nl.text }) : null,
      nlItems.length + nphiNL.length ? h("ul", { class: "plist" },
        nlItems.map(p => h("li", null, h("div", { class: "pt" }, link(p.title, p.url)), h("div", { class: "pm", text: [p.who, p.when].filter(Boolean).join(", ") }), h("div", { class: "ps", text: p.text }))),
        nphiNL.map(renderNphi)) : h("p", { class: "empty", text: "No Dutch-linked health projects found in public sources yet." })),
    h("div", { class: "pgroup" }, h("h3", null, "Institute collaborations", h("span", null, `${nphiOther.length} from the `, link("NPHI Collaboration Map", "../../nphi-map/"))),
      nphiOther.length ? expandable(nphiOther, 6, renderNphi, "collaborations") : h("p", { class: "empty", text: "None on the map for this country." })),
    h("div", { class: "pgroup" }, h("h3", null, "World Bank health projects", h("span", { text: `${wb.length} active` })),
      wb.length ? h("ul", { class: "plist" }, wb.map(p => h("li", null, h("div", { class: "pt" }, link(p.name, p.url)),
        h("div", { class: "pm", text: [p.usd ? `US$ ${fmtNum(p.usd)}` : "", p.approved ? `approved ${p.approved.slice(0, 4)}` : "", `closes ${shortDate(p.closing)}`].filter(Boolean).join(", ") }))))
        : h("p", { class: "empty", text: "No active World Bank health project listed for this country." })));

  /* calendar */
  const seen = new Set(), t0 = today();
  const events = [...(profile.calendar || []), ...(live.calendar || []), ...(live.holidays || [])].filter(e => (e.end || e.start) >= t0)
    .filter(e => { const k = e.start + e.title.toLowerCase().slice(0, 24); return seen.has(k) ? false : seen.add(k); })
    .sort((a, b) => a.start.localeCompare(b.start));
  const calendar = section("calendar", "Calendar", "",
    events.length ? h("ul", { class: "cal" }, events.map(e => { const [y, m, d] = e.start.split("-").map(Number);
      return h("li", null, h("div", { class: "dt" }, h("b", { text: e.day === false ? MONTHS[m - 1] : String(d) }), h("span", { text: e.day === false ? String(y) : `${MONTHS[m - 1]} ${y}` })),
        h("div", null, h("div", { class: "ev" }, link(e.title, e.src), e.status && e.status !== "confirmed" ? h("span", { class: "tag", text: e.status }) : null),
          h("div", { class: "pl", text: [e.place, e.end && e.end !== e.start ? `until ${shortDate(e.end)}` : ""].filter(Boolean).join(", ") }))); }))
      : h("p", { class: "empty", text: "Nothing on the calendar yet for this country." }));

  /* outbreaks and risk */
  const ob = live.outbreaks || [], risk = (live.risk || []).filter(r => !ob.some(o => o.url === r.url)), fc = live.forecasts || [];
  const alerts = section("alerts", "Outbreaks and risk", "",
    ob.length ? h("ul", { class: "alerts" }, ob.map(o => h("li", null, h("time", { datetime: o.date, text: `WHO outbreak notice, ${shortDate(o.date)}` }), link(o.title, o.url))))
      : h("p", { class: "empty", text: "No WHO Disease Outbreak News naming this country in the past year." }),
    risk.length ? h("h3", { class: "sub" }, "Signals on ", link("Risk Radar", "../../risk-radar/")) : null,
    risk.length ? h("ul", { class: "links" }, risk.map(r => h("li", null, link(r.title, r.url), h("span", { text: shortDate(r.date) })))) : null,
    fc.length ? h("h3", { class: "sub" }, "What prediction markets expect") : null,
    fc.length ? h("ul", { class: "links" }, fc.map(m => h("li", null, link(m.title, m.url),
      h("span", { text: (m.prob != null ? `${Math.round(m.prob * 100)}%` + (m.lead && m.kind !== "binary" ? ` for "${m.lead}"` : "") : "") + (m.end ? `, resolves ${shortDate(m.end)}` : "") })))) : null);

  /* numbers */
  const ind = live.indicators || [], jee = live.jee;
  const numbers = section("numbers", "Numbers", ind.length ? "Latest WHO figures; the tick marks the Netherlands." : "",
    ind.length ? h("dl", { class: "facts" }, ind.map(i => { const max = Math.max(i.value, i.nl || 0) || 1;
      return h("div", null, h("dt", { text: `${i.label}, ${i.unit}` }),
        h("dd", null, h("b", { text: fmtNum(i.value) }), h("span", { class: "cmp", text: i.year + (i.nl != null ? `, Netherlands ${fmtNum(i.nl)}` : "") })),
        i.nl != null ? h("div", { class: "bar" }, h("i", { style: `width:${Math.max(2, i.value / max * 100)}%` }), h("u", { style: `left:calc(${i.nl / max * 100}% - 1px)` })) : null); }))
      : h("p", { class: "empty", text: "Indicators are refreshed weekly and have not loaded yet." }),
    h("h3", { class: "sub", text: "Health security: Joint External Evaluation" }),
    jee ? h("div", null, h("p", { class: "small" }, `JEE ${jee.year} (edition ${jee.edition}): average ${jee.avg} out of 5 across ${jee.n} indicators. `, link("WHO report", jee.url), ". ", link("Good practices per indicator", "../../jee-good-practices/"), "."),
        h("div", { class: "jee" }, Object.entries(jee.areas).flatMap(([k, v]) => [h("span", { text: ({ P: "Prevent", D: "Detect", R: "Respond", PoE: "Points of entry", CE: "Chemical events", RE: "Radiation" })[k] || k }),
          h("div", { class: "bar", title: `${v} out of 5` }, h("i", { style: `width:${v / 5 * 100}%` }))])),
        jee.lowest.length ? h("p", { class: "small muted", text: `Scored 1 or 2: ${jee.lowest.join(", ")}.` }) : null)
      : h("p", { class: "empty", text: "No published JEE report with readable scores for this country." }),
    (profile.institutions || []).length ? h("h3", { class: "sub", text: "Who is who" }) : null,
    (profile.institutions || []).length ? h("ul", { class: "links" }, profile.institutions.map(i => h("li", null, link(i.name, i.url), h("span", { text: i.role })))) : null);

  /* headlines */
  const news = live.news || [];
  const renderNews = n => h("li", null, link(n.title, n.url), h("span", { text: [n.src, shortDate(n.date)].filter(Boolean).join(", ") }));
  const newsList = h("ul", { class: "news" }, news.slice(0, 14).map(renderNews));
  const moreNews = news.length > 14 ? h("button", { class: "more", type: "button", text: `Show all ${news.length} headlines`, onclick: () => { newsList.append(...news.slice(14).map(renderNews)); moreNews.remove(); } }) : null;
  const headlines = section("headlines", "Headlines", "Health news from and about the country in the past three weeks, newest first, unedited.",
    news.length ? newsList : h("p", { class: "empty", text: "No health headlines found in the past three weeks." }), moreNews);

  root.append(h("div", { class: "cols" }, h("div", null, highlights, agenda, projects), h("div", null, calendar, alerts, numbers)), headlines,
    h("footer", null,
      h("p", { text: `Page data updated ${live.generated ? shortDate(live.generated.slice(0, 10)) : "not yet"}. Headlines, outbreak notices and calendar refresh weekly; highlights and latest moves are written by Claude weekly from the linked headlines only; indicators and projects refresh weekly.` }),
      h("p", null, "Sources: Google News and the Global Health Ribbon (headlines), WHO Disease Outbreak News, WHO Global Health Observatory, World Bank projects, WHO JEE reports. Leadership, priorities, Dutch links and calendar are compiled by hand from the linked sources", profile.checked ? ` and were last checked on ${shortDate(profile.checked)}.` : "."),
      h("p", { text: "An automated digest can miss or misread things. Follow the links before relying on a point." }),
      (status.digest_errors || []).length ? h("p", { text: "Last digest had a problem: " + status.digest_errors[0] }) : null));
}

(slug ? renderCountry() : renderMap());
})();
