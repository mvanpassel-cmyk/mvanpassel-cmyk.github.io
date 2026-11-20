#!/usr/bin/env python3
"""Rebuild data.json for NList from charts.json.

charts.json lists every chart: id (an Our World in Data grapher slug), cat, title, unit.
For each chart this script downloads the OWID CSV and metadata, takes the latest value
per country from 2014 onwards, and keeps the EU plus a fixed world selection for display.
The Dutch rank is computed against all countries with data.

Usage:  python3 scripts/build.py            # rebuild everything
        python3 scripts/build.py --check s1 s2   # test candidate slugs without saving
"""
import csv, io, json, sys, datetime, urllib.request, concurrent.futures as cf

EU = set("AUT BEL BGR HRV CYP CZE DNK EST FIN FRA DEU GRC HUN IRL ITA LVA LTU LUX MLT NLD POL PRT ROU SVK SVN ESP SWE".split())
SHOW = EU | set("GBR NOR CHE ISL USA CAN AUS NZL JPN KOR BRA MEX IND CHN IDN TUR ZAF NGA EGY KEN ETH".split())
MIN_YEAR = 2014
UA = {"User-Agent": "Our World In Data data fetch/1.0"}
SKIPCOLS = {"World region according to OWID", "Population"}
SPECIAL = {
    "how-important-religion-is-in-your-life": lambda r: float(r["Not at all important"]),
    "share-of-new-cars-sold-that-are-battery-electric-and-plug-in-hybrid": lambda r: float(r["Plug-in hybrid"]) + float(r["Battery-electric"]),
    "pisa-mean-performance-on-the-mathematics-scale-by-sex": lambda r: (float(r["Girls"]) + float(r["Boys"])) / 2,
    "pisa-mean-performance-on-the-reading-scale-by-sex": lambda r: (float(r["Girls"]) + float(r["Boys"])) / 2,
}

def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90).read()

def load(slug):
    q = "?v=1&csvType=full&useColumnShortNames=false"
    text = get(f"https://ourworldindata.org/grapher/{slug}.csv{q}").decode("utf-8")
    try: meta = json.loads(get(f"https://ourworldindata.org/grapher/{slug}.metadata.json{q}"))
    except Exception: meta = {}
    rows = list(csv.DictReader(io.StringIO(text)))
    if not rows or "Year" not in rows[0]: raise ValueError("no yearly data")
    hdr = list(rows[0].keys())
    vals = [c for c in hdr[3:] if not c.endswith("(Annotations)") and c not in SKIPCOLS and "Projected" not in c]
    fn = SPECIAL.get(slug)
    if fn is None:
        if len(vals) != 1: raise ValueError(f"{len(vals)} value columns: {vals}")
        col = vals[0]; fn = lambda r: float(r[col])
    latest = {}
    for r in rows:
        c = r["Code"]
        if not c or len(c) != 3: continue
        try: v = fn(r); y = int(r["Year"])
        except (ValueError, TypeError, KeyError): continue
        if y < MIN_YEAR or y > datetime.date.today().year: continue
        if c not in latest or y > latest[c][1]: latest[c] = (r["Entity"], y, v)
    if "NLD" not in latest: raise ValueError("no recent Dutch value")
    shown = {c: v for c, v in latest.items() if c in SHOW}
    if len(shown) < 12: raise ValueError(f"only {len(shown)} comparison countries")
    order = sorted(latest, key=lambda c: -latest[c][2]); eu = [c for c in order if c in EU]
    return dict(src=meta.get("chart", {}).get("citation", ""), rank=order.index("NLD") + 1, n=len(latest),
                eur=eu.index("NLD") + 1, neu=len(eu),
                d=[[c, e, y, round(v, 3)] for c, (e, y, v) in sorted(shown.items(), key=lambda kv: -kv[1][2])])

def main():
    if len(sys.argv) > 2 and sys.argv[1] == "--check":
        for s in sys.argv[2:]:
            try:
                r = load(s); nl = next(x for x in r["d"] if x[0] == "NLD")
                print(f"OK   {s}: NL {nl[3]} ({nl[2]}), rank {r['rank']}/{r['n']}, EU {r['eur']}/{r['neu']}, {len(r['d'])} shown")
            except Exception as e: print(f"FAIL {s}: {e}")
        return
    reg = json.load(open("charts.json"))
    old = {}
    try: old = {c["id"]: c for c in json.load(open("data.json"))["charts"]}
    except Exception: pass
    def work(e):
        if e.get("manual"):
            d = e["data"]; order = [x[0] for x in d]
            return e, dict(src=e["src"], rank=order.index("NLD") + 1, n=len(d), eur=None, neu=None, d=d), None
        try: return e, load(e["id"]), None
        except Exception as ex: return e, None, str(ex)
    out, failed = [], []
    with cf.ThreadPoolExecutor(8) as ex:
        for e, r, err in ex.map(work, reg["charts"]):
            if r is None:
                failed.append(f"{e['id']}: {err}")
                if e["id"] in old: out.append(old[e["id"]])  # keep last good version
                continue
            out.append(dict(id=e["id"], cat=e["cat"], t=e["title"], u=e["unit"], src=r["src"],
                            url="" if e.get("manual") else f"https://ourworldindata.org/grapher/{e['id']}",
                            rank=r["rank"], n=r["n"], eur=r["eur"], neu=r["neu"], d=r["d"]))
    today = datetime.date.today()
    json.dump({"updated": f"{today.day} {today.strftime('%B %Y')}", "charts": out}, open("data.json", "w"), ensure_ascii=False, separators=(",", ":"))
    print(f"{len(out)} charts written, {len(failed)} failed")
    for f in failed: print("  FAILED", f)

if __name__ == "__main__":
    main()
