#!/usr/bin/env python3
"""Refresh the Commission country programmes in nphi-map/eu-programmes.json from IATI.

The EU layer of the NPHI map holds two kinds of entries:
  - kind "flagship": hand-checked Team Europe Initiatives, Global Gateway flagships, HERA/EU4Health
    actions and similar (edited by hand or by the monthly task; this script never touches them);
  - kind "country": European Commission programme-level actions (INTPA, NEAR, FPI) with a health
    sector share, taken from IATI via d-portal.org. This script rebuilds these.

Rules for country programmes: programme-level actions only (IATI id contains "-ACT-"), health
sectors 121/122/123/130 at >= 50% of the action or a clearly health-related title, ongoing or
ended from 2023 onwards, a commitment above zero, and no guarantees, blending or budget-support
lines that are mainly about something else.

Usage (from the repo root):  python3 nphi-map/tools/eu_iati.py
"""
import datetime, json, os, re, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
FILE = os.path.join(HERE, "..", "eu-programmes.json")
ATLAS = os.path.join(HERE, "..", "lib", "countries-110m.json")
ORGS = {"XI-IATI-EC_INTPA": "DG INTPA", "XI-IATI-EC_NEAR": "DG NEAR", "XI-IATI-EC_FPI": "FPI"}
SECTOR_GROUPS = ["121", "122", "123", "130"]
HEALTH_WORDS = ["health", "santé", "sante", "salud", "saúde", "vaccin", "medicin", "nutrition", "nutriç", "hiv", "malaria",
                "pandemic", "one health", "reproductive", "srhr", "rabies", "epidem", "hospital", "covid", "immunis"]
SKIP_WORDS = ["guarantee", "blending", "pegase", "unrwa", "facility for refugees in turkey - eu", "ms contribution",
              "integration facility", "visa", "border management", "migration", "civil status", "état civil", "drug trafficking"]
MIN_END_YEAR = 2023
TOPIC_RULES = [("preparedness", ["pandemic", "covid", "epidem", "surveillance", "health security", "emergenc", "outbreak"]),
               ("other", [""])]

# ISO 3166 alpha-2 -> world-atlas 2.0.2 (countries-110m) names, as used across the NPHI map.
ISO2 = {
 "AF":"Afghanistan","AL":"Albania","DZ":"Algeria","AO":"Angola","AR":"Argentina","AM":"Armenia","AZ":"Azerbaijan","BD":"Bangladesh",
 "BY":"Belarus","BZ":"Belize","BJ":"Benin","BT":"Bhutan","BO":"Bolivia","BA":"Bosnia and Herz.","BW":"Botswana","BR":"Brazil",
 "BF":"Burkina Faso","BI":"Burundi","KH":"Cambodia","CM":"Cameroon","CV":"Cabo Verde","CF":"Central African Rep.","TD":"Chad",
 "CL":"Chile","CN":"China","CO":"Colombia","KM":"Comoros","CG":"Congo","CD":"Dem. Rep. Congo","CR":"Costa Rica","CI":"Côte d'Ivoire",
 "CU":"Cuba","DJ":"Djibouti","DO":"Dominican Rep.","EC":"Ecuador","EG":"Egypt","SV":"El Salvador","GQ":"Eq. Guinea","ER":"Eritrea",
 "SZ":"eSwatini","ET":"Ethiopia","FJ":"Fiji","GA":"Gabon","GM":"Gambia","GE":"Georgia","GH":"Ghana","GT":"Guatemala","GN":"Guinea",
 "GW":"Guinea-Bissau","GY":"Guyana","HT":"Haiti","HN":"Honduras","IN":"India","ID":"Indonesia","IR":"Iran","IQ":"Iraq","IL":"Israel",
 "JM":"Jamaica","JO":"Jordan","KZ":"Kazakhstan","KE":"Kenya","XK":"Kosovo","KG":"Kyrgyzstan","LA":"Laos","LB":"Lebanon","LS":"Lesotho",
 "LR":"Liberia","LY":"Libya","MG":"Madagascar","MW":"Malawi","MY":"Malaysia","MV":"Maldives","ML":"Mali","MR":"Mauritania","MU":"Mauritius",
 "MX":"Mexico","MD":"Moldova","MN":"Mongolia","ME":"Montenegro","MA":"Morocco","MZ":"Mozambique","MM":"Myanmar","NA":"Namibia","NP":"Nepal",
 "NI":"Nicaragua","NE":"Niger","NG":"Nigeria","KP":"North Korea","MK":"Macedonia","PK":"Pakistan","PS":"Palestine","PA":"Panama",
 "PG":"Papua New Guinea","PY":"Paraguay","PE":"Peru","PH":"Philippines","RW":"Rwanda","WS":"Samoa","ST":"São Tomé and Principe",
 "SN":"Senegal","RS":"Serbia","SC":"Seychelles","SL":"Sierra Leone","SB":"Solomon Is.","SO":"Somalia","ZA":"South Africa","SS":"S. Sudan",
 "LK":"Sri Lanka","SD":"Sudan","SR":"Suriname","SY":"Syria","TJ":"Tajikistan","TZ":"Tanzania","TH":"Thailand","TL":"Timor-Leste","TG":"Togo",
 "TO":"Tonga","TT":"Trinidad and Tobago","TN":"Tunisia","TR":"Turkey","TM":"Turkmenistan","UG":"Uganda","UA":"Ukraine","UY":"Uruguay",
 "UZ":"Uzbekistan","VU":"Vanuatu","VE":"Venezuela","VN":"Vietnam","YE":"Yemen","ZM":"Zambia","ZW":"Zimbabwe","HR":"Croatia",
 "BB":"Barbados","KI":"Kiribati","TV":"Tuvalu","NR":"Nauru","PW":"Palau","MH":"Marshall Is.","FM":"Micronesia","LC":"Saint Lucia",
 "GD":"Grenada","DM":"Dominica","AG":"Antigua and Barb.","KN":"St. Kitts and Nevis","VC":"St. Vin. and Gren.","BS":"Bahamas",
}


def fetch(org, sg):
    url = f"https://d-portal.org/q.json?from=act,country,sector&limit=-1&reporting_ref={org}&sector_group={sg}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (NPHI map EU layer)"})
    return json.loads(urllib.request.urlopen(req, timeout=180).read()).get("rows", [])


def day(n):
    return datetime.date(1970, 1, 1) + datetime.timedelta(days=n) if n else None


def clean_title(t):
    t = re.sub(r"^\s*Activity under preparation\s+", "", t or "")
    t = re.sub(r"^NDICI[^-]*?-\s*", "", t)
    t = re.sub(r"\s*-?ACT-\d+\.?.*$", "", t)
    t = t.replace("¿", "'").replace("¿", "'").strip(" -")
    return t[:1].upper() + t[1:]


def short(desc, n=230):
    d = re.sub(r"\s+", " ", (desc or "").replace("¿", "'")).strip()
    if len(d) <= n:
        return d
    cut = d[:n]
    i = max(cut.rfind(". "), cut.rfind("; "))
    return (cut[:i + 1] if i > 80 else cut.rsplit(" ", 1)[0] + "…")


def main():
    atlas = {g["properties"]["name"] for g in json.load(open(ATLAS))["objects"]["countries"]["geometries"]}
    acts, sect = {}, {}
    for org in ORGS:
        for sg in SECTOR_GROUPS:
            for r in fetch(org, sg):
                a = acts.setdefault(r["aid"], dict(aid=r["aid"], org=ORGS[org], title=r["title"], desc=r.get("description") or "",
                                                   status=r["status_code"], start=r["day_start"], end=r["day_end"],
                                                   eur=r.get("commitment_eur") or 0, countries=set()))
                if r.get("country_code"):
                    a["countries"].add(r["country_code"])
                sect.setdefault(r["aid"], {})[r.get("sector_code")] = r.get("sector_percent") or 0
    today = datetime.date.today().isoformat()
    out, unmapped = [], set()
    for k, a in acts.items():
        if "-ACT-" not in k or not a["eur"]:
            continue
        end = day(a["end"])
        if end and end.year < MIN_END_YEAR:
            continue
        t = a["title"].lower()
        if any(w in t for w in SKIP_WORDS):
            continue
        share = sum(v for s, v in sect[k].items() if s and str(s)[:3] in SECTOR_GROUPS)
        if share < 50 and not any(w in t for w in HEALTH_WORDS):
            continue
        cs = []
        for c in sorted(a["countries"]):
            n = ISO2.get(c)
            if n:
                cs.append(n)
            else:
                unmapped.add(c)
        if not cs:
            continue
        start = day(a["start"])
        status = {1: "planned", 2: "ongoing", 3: "completed", 4: "completed"}.get(a["status"], "unclear")
        if status == "ongoing" and end and end.isoformat() < today:
            status = "completed"
        title = clean_title(a["title"])
        txt = (title + " " + a["desc"]).lower()
        topics = ["preparedness"] if any(w in txt for w in TOPIC_RULES[0][1]) else []
        if any(w in txt for w in ["vaccin", "manufactur", "medicines", "pharmaceut"]):
            topics.append("manufacturing")
        if any(w in txt for w in ["reproductive", "srhr", "maternal", "family planning", "population strategy", "gender-based violence", "early pregnancy"]):
            topics.append("srhr")
        if any(w in txt for w in ["nutrition", "nutriç", "malnutrition"]):
            topics.append("nutrition")
        if not topics:
            topics = ["systems"]
        out.append({
            "id": "eu-iati-" + re.sub(r"[^a-z0-9]+", "-", k.split("EC_")[-1].lower()).strip("-"),
            "kind": "country", "title": title, "origin": a["org"], "tei": None,
            "countries": cs, "scope": "single" if len(cs) == 1 else "multi", "region": "",
            "implementers": [], "members": [], "amountEURm": round(a["eur"] / 1e6, 1),
            "start": start.year if start else None, "end": end.year if end else None, "status": status,
            "topics": topics, "summary": short(a["desc"]), "nphi": False,
            "source": f"https://d-portal.org/ctrack.html#view=act&aid={urllib.request.quote(k)}",
            "iati": k, "checked": today,
        })
    bad = sorted({c for p in out for c in p["countries"] if c not in atlas})
    data = json.load(open(FILE)) if os.path.exists(FILE) else {"about": "", "projects": []}
    keep = [p for p in data.get("projects", []) if p.get("kind") != "country"]
    out.sort(key=lambda p: (-p["amountEURm"], p["title"]))
    data["projects"] = keep + out
    data["iatiRefreshed"] = today
    data["updated"] = today
    json.dump(data, open(FILE, "w"), ensure_ascii=False, indent=1)
    print(f"{len(out)} country programmes written ({len(keep)} flagships kept)")
    if unmapped:
        print("Unmapped ISO codes (add to ISO2):", ", ".join(sorted(unmapped)))
    if bad:
        print("Names not drawn as atlas shapes (need a position in index.html if they matter):", ", ".join(bad))


if __name__ == "__main__":
    sys.exit(main())
