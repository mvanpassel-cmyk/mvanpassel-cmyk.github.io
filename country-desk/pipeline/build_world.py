#!/usr/bin/env python3
"""Build data/shadow/world.json: every country the All countries desk covers.

Run by hand when the country list itself should change (rarely). It needs
network access and joins four sources:
  - mledoze/countries (ISO codes, capital, coordinates, alternative names)
  - WHO GHO country dimension (WHO region and WHO's own country name)
  - the Natural Earth names used by the NPHI map (nphi-map/lib/countries-110m.json)
  - the TrACSS 2025 country list (WHO naming used by the AMR portal)

Coverage: the 194 UN member states plus Cook Islands, Niue, Palestine, Kosovo and
Taiwan. Usage: python country-desk/pipeline/build_world.py
"""
import json, os, re, sys, urllib.request

DESK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(DESK)
OUT = os.path.join(DESK, "data", "shadow", "world.json")
MLEDOZE = "https://raw.githubusercontent.com/mledoze/countries/master/countries.json"
GHO = "https://ghoapi.azureedge.net/api/DIMENSION/COUNTRY/DimensionValues"
EXTRA = {"COK", "NIU", "PSE", "UNK", "XKX", "TWN"}     # Kosovo is XKX in mledoze, UNK elsewhere
REGIONS = {"AFR": "Africa", "AMR": "Americas", "SEAR": "South-East Asia", "EUR": "Europe",
           "EMR": "Eastern Mediterranean", "WPR": "Western Pacific"}
# Names that read better than the WHO or ISO official form.
DISPLAY = {"PSE": "Palestine", "COD": "DR Congo", "COG": "Congo", "KOR": "South Korea", "PRK": "North Korea",
           "LAO": "Laos", "SYR": "Syria", "IRN": "Iran", "RUS": "Russia", "VNM": "Vietnam", "TZA": "Tanzania",
           "BOL": "Bolivia", "VEN": "Venezuela", "MDA": "Moldova", "FSM": "Micronesia", "CZE": "Czechia",
           "TUR": "Türkiye", "CIV": "Côte d'Ivoire", "CPV": "Cabo Verde", "SWZ": "Eswatini", "TLS": "Timor-Leste",
           "BRN": "Brunei", "VAT": "Holy See", "XKX": "Kosovo", "UNK": "Kosovo", "TWN": "Taiwan", "MKD": "North Macedonia",
           "GBR": "United Kingdom", "USA": "United States", "NLD": "Netherlands"}


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "CountryDeskBot/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def slugify(name):
    s = name.lower().replace("ô", "o").replace("é", "e").replace("ü", "u").replace("ç", "c").replace("í", "i").replace("ã", "a")
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def main():
    mledoze = get(MLEDOZE)
    gho = {x["Code"]: x for x in get(GHO)["value"]}
    topo = json.load(open(os.path.join(REPO, "nphi-map", "lib", "countries-110m.json"), encoding="utf-8"))
    ne = {g.get("id"): g.get("properties", {}).get("name") for g in topo["objects"]["countries"]["geometries"]}
    tracss = {c["iso"]: c["n"] for c in json.load(open(os.path.join(REPO, "tracss-good-practices", "data", "tracss-2025.json"), encoding="utf-8"))["countries"]}
    desk = json.load(open(os.path.join(DESK, "data", "countries.json"), encoding="utf-8"))
    desk_slug = {c["iso3"]: c["slug"] for c in desk["countries"]}

    out = []
    for c in mledoze:
        iso3 = c["cca3"]
        if not (c.get("unMember") or iso3 in EXTRA):
            continue
        g = gho.get(iso3, {})
        name = DISPLAY.get(iso3) or c["name"]["common"]
        names = [name, c["name"]["common"], c["name"]["official"], g.get("Title"), ne.get(c.get("ccn3")), tracss.get(iso3)]
        names += [a for a in c.get("altSpellings", []) if len(a) > 3 and not a.isupper()]
        seen, clean = set(), []
        for n in names:
            if n and n.casefold() not in seen and not n.lower().startswith("occupied"):
                seen.add(n.casefold())
                clean.append(n)
        lat, lon = (c.get("capitalInfo", {}).get("latlng") or c.get("latlng") or [0, 0])[:2]
        out.append({"iso3": iso3, "iso2": c["cca2"], "num": c.get("ccn3") or "", "name": name, "names": clean,
                    "slug": slugify(name), "capital": (c.get("capital") or [""])[0],
                    "lat": round(lat, 2), "lon": round(lon, 2),
                    "region": REGIONS.get(g.get("ParentCode"), "Not a WHO region" if iso3 in ("TWN", "XKX", "UNK", "VAT") else ""),
                    **({"desk": desk_slug[iso3]} if iso3 in desk_slug else {})})
    out.sort(key=lambda x: x["name"])
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"_doc": "Countries covered by the All countries desk. Built by pipeline/build_world.py; edit names by hand if needed.",
                   "countries": out}, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"{len(out)} countries written, {sum('desk' in x for x in out)} have a full desk page")
    return 0


if __name__ == "__main__":
    sys.exit(main())
