/* Country Desk, All countries. A list of every country (#) and one shadow page per
   country without a full desk (#ghana). Data refreshed by hand: data/shadow/. */
(() => {
"use strict";
const $ = s => document.querySelector(s);
const root = $("#all");

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
const getJSON = (p, fallback) => fetch("../" + p, { cache: "no-cache" }).then(r => r.ok ? r.json() : fallback).catch(() => fallback);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const today = () => new Date().toISOString().slice(0, 10);
function shortDate(iso) { if (!iso) return ""; const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]}` + (y !== new Date().getFullYear() ? ` ${y}` : ""); }
function fmtNum(v) {
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(v >= 1e10 ? 0 : 1) + " billion";
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + " million";
  if (Math.abs(v) >= 100) return Math.round(v).toLocaleString("en-GB");
  return (Math.round(v * 10) / 10).toLocaleString("en-GB");
}
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return "Source"; } };
const REGION_ORDER = ["Africa", "Americas", "Eastern Mediterranean", "Europe", "South-East Asia", "Western Pacific", "Not a WHO region"];

let INDEX = null, STATUS = {}, WORLD = [];
const state = { q: "", region: "" };

async function boot() {
  [INDEX, STATUS, WORLD] = await Promise.all([getJSON("data/shadow/index.json", null), getJSON("data/shadow/status.json", {}), getJSON("data/shadow/world.json", { countries: [] }).then(w => w.countries)]);
  window.addEventListener("hashchange", route);
  route();
}

function route() {
  const key = decodeURIComponent(location.hash.slice(1));
  root.replaceChildren();
  window.scrollTo(0, 0);
  if (!INDEX) { root.append(h("p", { class: "empty", text: "The country list could not be loaded. Reload the page to try again." })); return; }
  const c = key && INDEX.countries.find(x => x.slug === key || x.iso3.toLowerCase() === key.toLowerCase());
  if (c && c.desk) { location.replace(`../${c.desk}/`); return; }
  if (c) renderCountry(c); else renderList();
}

/* =================== list =================== */
function renderList() {
  document.title = "All countries | Country Desk";
  const all = INDEX.countries, shadow = all.filter(c => !c.desk);
  const sketched = shadow.filter(c => c.checked).length;
  const refreshed = shadow.map(c => c.refreshed).filter(Boolean).sort().pop();
  const list = h("div", { class: "alllist" });
  const count = h("p", { class: "small muted", "aria-live": "polite" });

  const draw = () => {
    const q = state.q.trim().toLowerCase();
    const rows = all.filter(c => (!state.region || c.region === state.region) &&
      (!q || c.name.toLowerCase().includes(q) || (c.minister || "").toLowerCase().includes(q) || (c.line || "").toLowerCase().includes(q)));
    count.textContent = `${rows.length} of ${all.length} countries`;
    const shown = new Set(rows.map(c => c.iso3));
    mapBox.querySelectorAll("a[data-iso]").forEach(a => a.classList.toggle("dim", !shown.has(a.dataset.iso)));
    const groups = REGION_ORDER.map(r => [r, rows.filter(c => c.region === r)]).filter(([, rs]) => rs.length);
    list.replaceChildren(...(rows.length ? groups.map(([r, rs]) => h("section", { class: "region" },
      h("h2", null, r, h("span", { text: String(rs.length) })),
      h("ul", { class: "desks shadowlist" }, rs.map(row)))) : [h("p", { class: "empty", text: "No country matches. Try another spelling, or clear the region filter." })]));
  };
  const row = c => h("li", { class: c.desk ? "full" : "" }, h("a", { href: c.desk ? `../${c.desk}/` : `#${c.slug}` },
    h("span", { class: "name" }, h("i"), c.name),
    h("span", { class: "top" }, c.desk ? "Full desk page, updated weekly" : (c.line || "No sketch yet; figures and projects are on the page."),
      c.minister ? h("span", { text: `Health: ${c.minister}` }) : null),
    h("span", { class: "counts" }, c.desk ? h("b", { class: "tag fulltag", text: "Full desk" }) :
      [c.life != null ? `Life expectancy ${fmtNum(c.life)}` : "", c.projects ? `${c.projects} projects` : "", c.outbreaks ? `${c.outbreaks} outbreak notice${c.outbreaks > 1 ? "s" : ""}` : ""].filter(Boolean).join(", "))));

  const mapBox = h("div", { class: "map allmap" });
  const legend = h("p", { class: "maplegend" }, h("span", null, h("i", { style: "background:var(--ink)" }), "Full desk, weekly"),
    h("span", null, h("i", { style: "background:var(--spot)" }), "Shadow page with sketch"),
    h("span", null, h("i", { style: "background:color-mix(in srgb,var(--spot) 45%,var(--land))" }), "Figures only"));
  const search = h("input", { type: "search", placeholder: "Search a country, minister or topic", "aria-label": "Search countries", value: state.q,
    oninput: e => { state.q = e.target.value; draw(); } });
  const chips = h("div", { class: "chips", role: "group", "aria-label": "Filter by WHO region" },
    ["", ...REGION_ORDER].map(r => h("button", { type: "button", class: "chip", "aria-pressed": String(state.region === r), text: r || "All regions",
      onclick: e => { state.region = r; chips.querySelectorAll(".chip").forEach(b => b.setAttribute("aria-pressed", String(b === e.currentTarget))); draw(); } })));

  root.append(
    h("a", { class: "back", href: "../" }, "Country Desk"),
    h("header", { class: "mast" }, h("div", null, h("h1", { text: "All countries" }),
      h("p", null, `Basic health information for every country. ${all.length - shadow.length} countries have a full desk page that updates weekly; the other ${shadow.length} are refreshed by hand`,
        refreshed ? `, last on ${shortDate(refreshed)}` : "", "."))),
    mapBox, legend,
    h("div", { class: "tools" }, search, chips, count),
    list,
    h("footer", null,
      h("p", { text: `Figures, projects and outbreak notices come from WHO, the World Bank and the sibling tools; ${sketched} of ${shadow.length} countries have a short sketch written by Claude with web search, each point linked to its source.` }),
      h("p", { text: "Pages here are refreshed irregularly. For a country you follow closely, a full desk page is better." })));
  drawMap(mapBox, all);
  draw();
  if (state.q) search.focus();
}

async function drawMap(box, all) {
  try {
    const topo = await fetch("../../nphi-map/lib/countries-110m.json").then(r => r.json());
    if (!window.d3 || !window.topojson) throw new Error("map library missing");
    const byNum = {}, rows = Object.fromEntries(all.map(c => [c.iso3, c]));
    for (const w of WORLD) if (w.num && rows[w.iso3]) byNum[w.num] = rows[w.iso3];
    const W = 1100, H = 500, svg = d3.select(box).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img")
      .attr("aria-label", "World map; every country links to its page");
    const feats = topojson.feature(topo, topo.objects.countries).features.filter(f => f.id !== "010");
    const proj = d3.geoNaturalEarth1().rotate([-20, 0]).fitExtent([[6, 6], [W - 6, H - 6]], { type: "FeatureCollection", features: feats });
    const path = d3.geoPath(proj);
    for (const f of feats) {
      const c = byNum[f.id];
      if (!c) { svg.append("path").attr("class", "land").attr("d", path(f)); continue; }
      const a = svg.append("a").attr("href", c.desk ? `../${c.desk}/` : `#${c.slug}`).attr("data-iso", c.iso3).attr("aria-label", c.name);
      a.append("title").text(c.name + (c.desk ? " (full desk)" : ""));
      a.append("path").attr("class", c.desk ? "shadow full" : c.checked ? "shadow sketched" : "shadow").attr("d", path(f));
    }
  } catch (e) { box.remove(); }
}

/* =================== country =================== */
function section(id, title, lede, ...body) {
  return h("section", { id }, h("h2", { text: title }), lede ? h("p", { class: "lede", text: lede }) : null, ...body);
}

async function renderCountry(c) {
  document.title = `${c.name} | All countries | Country Desk`;
  const iso = c.iso3.toLowerCase();
  const [live, sk, world] = await Promise.all([getJSON(`data/shadow/live/${iso}.json`, {}), getJSON(`data/shadow/sketch/${iso}.json`, {}), getJSON("data/shadow/world.json", { countries: [] })]);
  const w = world.countries.find(x => x.iso3 === c.iso3) || {};

  const stamp = [live.refreshed ? `figures ${shortDate(live.refreshed)}` : "figures not yet loaded", sk.checked ? `sketch ${shortDate(sk.checked)}` : "no sketch yet"].join(", ");
  root.append(
    h("a", { class: "back", href: "#" }, "All countries"),
    h("header", { class: "head" }, h("div", null, h("h1", { text: c.name }),
      h("p", { class: "sub", text: [w.capital ? `Capital ${w.capital}` : "", c.region && c.region !== "Not a WHO region" ? `WHO ${c.region} Region` : c.region].filter(Boolean).join(", ") })),
      h("div", { class: "shadownote" }, h("b", { text: "Shadow page" }), h("span", { text: `Refreshed by hand: ${stamp}.` }))),
    sk.minister ? h("ul", { class: "who" }, h("li", null, h("div", { class: "role", text: sk.minister.role + (sk.minister.since ? `, since ${sk.minister.since}` : "") }),
      h("div", { class: "nm" }, link(sk.minister.name, sk.minister.src)))) : null);

  /* sketch */
  const pr = sk.priorities || [];
  const sketch = section("sketch", "Sketch", sk.checked ? `Written by Claude with web search on ${shortDate(sk.checked)}; every point links to the page it rests on.` : "",
    sk.snapshot ? h("p", { class: "snap" }, sk.snapshot.text, " ", h("span", { class: "srcs" }, sk.snapshot.src.map(u => link(host(u), u)))) : null,
    pr.length ? h("div", { class: "agenda" }, pr.map(p => h("article", null, h("h3", { text: p.title }), h("p", { text: p.text }), h("p", { class: "srcs" }, link(host(p.src), p.src))))) : null,
    sk.netherlands ? h("p", { class: "watch" }, h("b", { text: "Netherlands: " }), sk.netherlands.text, " ", link(host(sk.netherlands.src), sk.netherlands.src, "small")) : null,
    !sk.snapshot && !pr.length ? h("p", { class: "empty", text: "No sketch yet. It is written at the next manual refresh; the figures and projects below are already there." }) : null);

  /* projects */
  const nphi = live.nphi || [], wb = live.wbProjects || [];
  const nphiNL = nphi.filter(p => p.nl), nphiOther = nphi.filter(p => !p.nl);
  const renderNphi = p => h("li", null, h("div", { class: "pt" }, link(p.title, p.url)),
    h("div", { class: "pm", text: [p.actor + (p.actorCountry ? ` (${p.actorCountry})` : ""), p.type, [p.start, p.end].filter(Boolean).join(" to "), p.status].filter(Boolean).join(", ") }));
  const expandable = (rows, first, render, noun) => {
    const ul = h("ul", { class: "plist" }, rows.slice(0, first).map(render));
    if (rows.length <= first) return [ul];
    const btn = h("button", { class: "more", type: "button", text: `Show all ${rows.length} ${noun}`, onclick: () => { ul.append(...rows.slice(first).map(render)); btn.remove(); } });
    return [ul, btn];
  };
  const projects = section("projects", "Projects and partnerships", "Dutch links first, then other public health institutes, then active World Bank health projects.",
    nphiNL.length ? h("div", { class: "pgroup" }, h("h3", null, "Dutch links", h("span", { text: `${nphiNL.length} found` })), h("ul", { class: "plist" }, nphiNL.map(renderNphi))) : null,
    h("div", { class: "pgroup" }, h("h3", null, "Institute collaborations", h("span", null, `${nphiOther.length} from the `, link("NPHI Collaboration Map", "../../nphi-map/"))),
      nphiOther.length ? expandable(nphiOther, 5, renderNphi, "collaborations") : h("p", { class: "empty", text: "None on the map for this country." })),
    h("div", { class: "pgroup" }, h("h3", null, "World Bank health projects", h("span", { text: `${wb.length} active` })),
      wb.length ? expandable(wb, 5, p => h("li", null, h("div", { class: "pt" }, link(p.name, p.url)),
        h("div", { class: "pm", text: [p.usd ? `US$ ${fmtNum(p.usd)}` : "", p.approved ? `approved ${p.approved.slice(0, 4)}` : "", `closes ${shortDate(p.closing)}`].filter(Boolean).join(", ") })), "projects")
        : h("p", { class: "empty", text: "No active World Bank health project listed." })));

  /* calendar */
  const seen = new Set(), t0 = today();
  const events = [...(live.calendar || []), ...(live.holidays || [])].filter(e => (e.end || e.start) >= t0)
    .filter(e => { const k = e.start + e.title.toLowerCase().slice(0, 24); return seen.has(k) ? false : seen.add(k); })
    .sort((a, b) => a.start.localeCompare(b.start)).slice(0, 10);
  const calendar = section("calendar", "Calendar", "",
    events.length ? h("ul", { class: "cal" }, events.map(e => { const [y, m, d] = e.start.split("-").map(Number);
      return h("li", null, h("div", { class: "dt" }, h("b", { text: String(d) }), h("span", { text: `${MONTHS[m - 1]} ${y}` })),
        h("div", null, h("div", { class: "ev" }, link(e.title, e.src), e.status && e.status !== "confirmed" ? h("span", { class: "tag", text: e.status }) : null),
          h("div", { class: "pl", text: [e.place, e.end && e.end !== e.start ? `until ${shortDate(e.end)}` : ""].filter(Boolean).join(", ") }))); }))
      : h("p", { class: "empty", text: "Nothing on the calendar for this country." }));

  /* outbreaks and risk */
  const ob = live.outbreaks || [], risk = live.risk || [];
  const alerts = section("alerts", "Outbreaks and risk", "",
    ob.length ? h("ul", { class: "alerts" }, ob.map(o => h("li", null, h("time", { datetime: o.date, text: `WHO outbreak notice, ${shortDate(o.date)}` }), link(o.title, o.url))))
      : h("p", { class: "empty", text: "No WHO Disease Outbreak News naming this country in the year before the last refresh." }),
    risk.length ? h("h3", { class: "sub" }, "Signals on ", link("Risk Radar", "../../risk-radar/")) : null,
    risk.length ? h("ul", { class: "links" }, risk.map(r => h("li", null, link(r.title, r.url), h("span", { text: shortDate(r.date) })))) : null);

  /* numbers */
  const ind = live.indicators || [], jee = live.jee, tr = live.tracss;
  const numbers = section("numbers", "Numbers", ind.length ? "Latest WHO figures; the tick marks the Netherlands." : "",
    ind.length ? h("dl", { class: "facts" }, ind.map(i => { const max = Math.max(i.value, i.nl || 0) || 1;
      return h("div", null, h("dt", { text: `${i.label}, ${i.unit}` }),
        h("dd", null, h("b", { text: fmtNum(i.value) }), h("span", { class: "cmp", text: i.year + (i.nl != null ? `, Netherlands ${fmtNum(i.nl)}` : "") })),
        i.nl != null ? h("div", { class: "bar" }, h("i", { style: `width:${Math.max(2, i.value / max * 100)}%` }), h("u", { style: `left:calc(${i.nl / max * 100}% - 1px)` })) : null); }))
      : h("p", { class: "empty", text: "No WHO figures for this country yet." }),
    h("h3", { class: "sub", text: "Health security: Joint External Evaluation" }),
    jee ? h("div", null, h("p", { class: "small" }, `JEE ${jee.year} (edition ${jee.edition}): average ${jee.avg} out of 5 across ${jee.n} indicators. `, link("WHO report", jee.url), ". ", link("Good practices per indicator", "../../jee-good-practices/"), "."),
        h("div", { class: "jee" }, Object.entries(jee.areas).flatMap(([k, v]) => [h("span", { text: ({ P: "Prevent", D: "Detect", R: "Respond", PoE: "Points of entry", CE: "Chemical events", RE: "Radiation" })[k] || k }),
          h("div", { class: "bar", title: `${v} out of 5` }, h("i", { style: `width:${v / 5 * 100}%` }))])),
        jee.lowest.length ? h("p", { class: "small muted", text: `Scored 1 or 2: ${jee.lowest.join(", ")}.` }) : null)
      : h("p", { class: "empty", text: "No published JEE report with readable scores for this country." }),
    h("h3", { class: "sub", text: "Antimicrobial resistance: TrACSS" }),
    tr ? h("p", { class: "small" }, `TrACSS ${tr.round}: average level ${tr.avg} out of 5 (A to E) across ${tr.n} rated questions. `,
        tr.nap ? [link("National action plan", tr.nap), ". "] : "", link("All answers in the TrACSS portal", "../../tracss-good-practices/"), ".")
      : h("p", { class: "empty", text: "No TrACSS 2025 answers for this country." }));

  root.append(h("div", { class: "cols" }, h("div", null, sketch, projects), h("div", null, calendar, alerts, numbers)),
    h("footer", null,
      h("p", { text: "This is a shadow page: refreshed by hand, irregularly. Sources: WHO Global Health Observatory, World Bank projects, WHO Disease Outbreak News, WHO JEE reports, TrACSS 2025, the NPHI Collaboration Map, Risk Radar and the World Calendar." }),
      h("p", { text: "The sketch is written automatically and can miss or misread things. Follow the links before relying on a point." })));
}

boot();
})();
