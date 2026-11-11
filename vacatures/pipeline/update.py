#!/usr/bin/env python3
"""Dagelijkse update voor de Vacaturemonitor Onderwijs.

Alleen standaardbibliotheek. Bewaart per vacature uitsluitend de gegevens die de
bron zelf als kenmerken toont (titel, werkgever, plaats, uren, salaris, data),
een link naar het origineel en een link naar een kopie bij het Internet Archive.
De vacatureteksten zelf worden niet gekopieerd.

Gebruik:
  python vacatures/pipeline/update.py            # alle bronnen ophalen
  python vacatures/pipeline/update.py --offline  # alleen coördinaten en velden aanvullen
"""
import datetime as dt
import hashlib
import html as htmllib
import json
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
TEXT_ARCHIVE = ROOT / "archief"
UA = ("vacature-monitor/1.0 (persoonlijke vacaturemonitor; "
      "+https://mvanpassel-cmyk.github.io/vacatures/)")
MAX_ARCHIVE_PER_RUN = 10
MAX_REJECTED = 800

MONTHS = {"jan": 1, "feb": 2, "mrt": 3, "mar": 3, "apr": 4, "mei": 5, "may": 5,
          "maa": 3, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "okt": 10, "oct": 10,
          "nov": 11, "dec": 12}

# Plaats (kleine letters) -> (breedtegraad, lengtegraad)
PLACES = {
    "amsterdam": (52.3676, 4.9041), "rotterdam": (51.9244, 4.4777),
    "den haag": (52.0705, 4.3007), "utrecht": (52.0907, 5.1214),
    "eindhoven": (51.4416, 5.4697), "groningen": (53.2194, 6.5665),
    "maastricht": (50.8514, 5.6910), "nijmegen": (51.8126, 5.8372),
    "enschede": (52.2215, 6.8937), "delft": (52.0116, 4.3571),
    "leiden": (52.1601, 4.4970), "tilburg": (51.5555, 5.0913),
    "breda": (51.5719, 4.7683), "arnhem": (51.9851, 5.8987),
    "zwolle": (52.5168, 6.0830), "amersfoort": (52.1561, 5.3878),
    "heerlen": (50.8882, 5.9795), "wageningen": (51.9692, 5.6654),
    "apeldoorn": (52.2112, 5.9699), "deventer": (52.2661, 6.1552),
    "almere": (52.3508, 5.2647), "haarlem": (52.3874, 4.6462),
    "hilversum": (52.2292, 5.1669), "zeist": (52.0895, 5.2310),
    "den bosch": (51.6978, 5.3037), "ede": (52.0402, 5.6649),
    "leeuwarden": (53.2012, 5.7999), "venlo": (51.3704, 6.1724),
    "sittard-geleen": (51.0000, 5.8667), "zoetermeer": (52.0575, 4.4931),
    "dordrecht": (51.8133, 4.6901), "alphen aan den rijn": (52.1292, 4.6577),
    "amstelveen": (52.3081, 4.8722), "lelystad": (52.5185, 5.4714),
    "emmen": (52.7792, 6.9006), "assen": (52.9925, 6.5649),
    "middelburg": (51.4988, 3.6109), "vlissingen": (51.4423, 3.5736),
    "helmond": (51.4793, 5.6570), "roermond": (51.1942, 5.9870),
    "hengelo": (52.2658, 6.7931), "rijswijk": (52.0363, 4.3250),
    "gouda": (52.0115, 4.7105), "hoofddorp": (52.3061, 4.6907),
    "nieuwegein": (52.0292, 5.0805), "veenendaal": (52.0285, 5.5584),
    "driebergen": (52.0525, 5.2810), "bussum": (52.2747, 5.1608),
    "soest": (52.1733, 5.2917), "houten": (52.0286, 5.1685),
    "woerden": (52.0850, 4.8830), "heerenveen": (52.9600, 5.9200),
    "meppel": (52.6957, 6.1944), "harderwijk": (52.3400, 5.6200),
    "kampen": (52.5550, 5.9114), "doetinchem": (51.9650, 6.2889),
    "zutphen": (52.1389, 6.2000), "hoorn": (52.6425, 5.0597),
    "alkmaar": (52.6324, 4.7534), "den helder": (52.9563, 4.7608),
}
ALIASES = {"'s-gravenhage": "den haag", "s-gravenhage": "den haag",
           "’s-gravenhage": "den haag", "the hague": "den haag",
           "'s-hertogenbosch": "den bosch", "’s-hertogenbosch": "den bosch",
           "s-hertogenbosch": "den bosch", "sittard": "sittard-geleen",
           "geleen": "sittard-geleen"}


# ---------------------------------------------------------------- helpers
def fetch_text(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                               "Accept-Language": "nl,en;q=0.5"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def norm_city(name):
    if not name:
        return None
    key = re.sub(r"\s+", " ", name.strip().lower())
    return ALIASES.get(key, key)


def display_city(name):
    key = norm_city(name)
    if key in PLACES:
        return key.title() if key != "den haag" else "Den Haag"
    return name.strip() if name else None


def coords_for(city):
    return PLACES.get(norm_city(city))


def city_from_address(address):
    """Haal de plaatsnaam uit een adres als 'Stationsplein, 3818 LE, Amersfoort'."""
    if not address:
        return None
    address = re.sub(r"(?i)bekijk op google maps", "", address).strip()
    parts = [p.strip() for p in address.split(",") if p.strip()]
    if not parts:
        return None
    last = re.sub(r"^\d{4}\s?[A-Za-z]{2}\s+", "", parts[-1])
    last = re.sub(r"(?i)^(nederland|netherlands)$", "", last).strip()
    if re.fullmatch(r"\d{4}\s?[A-Za-z]{2}", last or ""):
        return None
    return display_city(last) if last else None


def to_text(markup):
    markup = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", markup)
    markup = re.sub(r"(?i)<br\s*/?>|</(p|div|li|h[1-6]|section|article|dt|dd|tr|header|footer|main)>", "\n", markup)
    markup = re.sub(r"(?s)<[^>]+>", " ", markup)
    markup = htmllib.unescape(markup)
    lines = [re.sub(r"[ \t ]+", " ", ln).strip() for ln in markup.splitlines()]
    return "\n".join(ln for ln in lines if ln)


def parse_nl_date(day, mon, yy):
    try:
        month = MONTHS[mon.lower().rstrip(".")[:3]]
        year = int(yy) + (2000 if int(yy) < 100 else 0)
        return dt.date(year, month, int(day))
    except (KeyError, ValueError):
        return None


def fmt_eur(n):
    return "€ " + f"{int(float(n)):,}".replace(",", ".")


def to_float(s):
    return float(s.replace(",", "."))


# ------------------------------------------------------------- filtering
def compile_rules(cfg):
    return {
        "include": re.compile(cfg["include_slug"], re.I),
        "classroom": re.compile(cfg["classroom_title"], re.I),
        "keep": re.compile(cfg["classroom_keep"], re.I),
        "exclude": re.compile(cfg["exclude_title"], re.I),
        "higher_ed": re.compile(cfg["higher_ed_employer"], re.I),
    }


def accept_title(title, rules, employer=None):
    """False voor vacatures om voor de klas te staan en voor administratieve functies.

    'Docent pabo' bij een hogeschool of universiteit is een lerarenopleider en blijft staan;
    bij een andere werkgever is het meestal een functie voor de klas en valt af."""
    if rules["exclude"].search(title):
        return False
    if rules["classroom"].search(title) and not rules["keep"].search(title):
        if re.search(r"pabo", title, re.I) and employer and rules["higher_ed"].search(employer):
            return True
        return False
    return True


TOPIC_RULES = [
    ("pabo", r"pabo|basisonderwijs|primary teacher"),
    ("lerarenopleiding", r"lerarenopleid|pabo|teacher educ|lerarenopleider"),
    ("onderwijsadvies", r"advis|beleid|onderwijskundig|onderwijsontwikkel|educational develop|opleidingsmanager|onderwijsmanager"),
    ("onderwijsonderzoek", r"onderzoek|onderwijswetenschap|postdoc|promov|research|didactiek"),
    ("curriculum", r"curriculum|toets|examin|didactiek|vakdidact"),
]


def topics_for(title):
    found = [name for name, pat in TOPIC_RULES if re.search(pat, title, re.I)]
    return found or ["overig"]


# --------------------------------------------------- AcademicTransfer
def parse_academictransfer(markup, url, today):
    m = re.search(r"(?is)<title[^>]*>(.*?)</title>", markup)
    if not m:
        return None
    parts = [p.strip() for p in re.split(r"\s+—\s+", htmllib.unescape(m.group(1)).strip())]
    if len(parts) < 3 or not parts[-1].lower().startswith("academictransfer"):
        return None
    title = " — ".join(parts[:-2])
    employer = parts[-2]
    text = to_text(markup)

    deadline = published = None
    d = re.search(r"Deadline\s+(\d{1,2})\s+([A-Za-z]{3,5})\.?\s*[’'‘`]\s*(\d{2})", text)
    if d:
        deadline = parse_nl_date(*d.groups())
    p = re.search(r"(\d{1,2})\s+([A-Za-z]{3,5})\.?\s*[’'‘`]\s*(\d{2})\s+gepubliceerd", text, re.I)
    if p:
        published = parse_nl_date(*p.groups())
    else:
        rel = re.search(r"(vandaag|gisteren)\s+gepubliceerd", text, re.I)
        if rel:
            published = today - dt.timedelta(days=1 if rel.group(1).lower() == "gisteren" else 0)

    salary = None
    s = re.search(r"€\s?([\d.]+)\s*[—–-]+\s*€\s?([\d.]+)\s*per maand", text)
    if s:
        lo, hi = (int(x.replace(".", "")) for x in s.groups())
        salary = f"{fmt_eur(lo)} – {fmt_eur(hi)} per maand"

    hours = None
    h = re.search(r"([\d.,]+)\s*[—–-]+\s*([\d.,]+)\s*uur per week", text, re.I)
    if h:
        hours = [to_float(h.group(1)), to_float(h.group(2))]
    else:
        h = re.search(r"(\d+(?:[.,]\d+)?)\s*uur per week", text, re.I)
        if h:
            hours = [to_float(h.group(1))] * 2

    city = None
    loc = re.search(r"(?im)^locatie\s*\n([^\n]+)", text)
    if loc:
        city = city_from_address(loc.group(1))

    return {
        "title": title, "employer": employer, "city": city, "hours": hours,
        "salary": salary, "published": published.isoformat() if published else None,
        "deadline": deadline.isoformat() if deadline else None, "url": url,
    }


def crawl_academictransfer(cfg, rules, existing, rejected, today, fetch=fetch_text, sleep=time.sleep):
    """Geeft (nieuwe records, gezien-ids, aantal kandidaten) terug."""
    sitemap = fetch(cfg["sitemap"])
    best = {}
    for u in re.findall(r"<loc>([^<]+)</loc>", sitemap):
        m = re.search(r"/(nl|en)/jobs/(\d+)/([^/?#]+)", u)
        if not m:
            continue
        lang, jid, slug = m.groups()
        if not rules["include"].search(slug):
            continue
        if jid not in best or lang == "nl":
            best[jid] = u
    seen, new = set(), []
    fetched = 0
    delay = cfg.get("crawl_delay", 10)
    limit = cfg.get("max_new_pages", 25)
    for jid in sorted(best, key=int, reverse=True):
        rid = f"at-{jid}"
        seen.add(rid)
        if rid in existing or rid in rejected or fetched >= limit:
            continue
        if fetched:
            sleep(delay)  # robots.txt van AcademicTransfer vraagt om 10 seconden
        fetched += 1
        try:
            rec = parse_academictransfer(fetch(best[jid]), best[jid], today)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            print(f"  ! {rid}: ophalen mislukt ({exc})")
            continue
        if not rec:
            rejected[rid] = "pagina niet herkend"
            continue
        if not accept_title(rec["title"], rules, rec.get("employer")):
            rejected[rid] = "buiten bereik: " + rec["title"][:60]
            continue
        new.append(make_record(rid, "AcademicTransfer", rec, today))
    return new, seen, len(best)


# ------------------------------------------------------------------ Werken bij hogescholen
WBH_BASE = "https://www.werkenbijhogescholen.nl"
_WBH_SKIP = re.compile(r"^((layout|not-found|page)-[0-9a-f]{16}|favorieten)$")


def parse_wbh_listing(markup):
    """Vacaturekaarten op een overzichtspagina: [(slug, werkgever, titel, plaats)] en het totaal."""
    cards = []
    for m in re.finditer(r'<a[^>]+href="/vacatures/([a-z0-9-]{4,})"[^>]*>(.*?)</a>', markup, re.S):
        slug = m.group(1)
        if _WBH_SKIP.match(slug):
            continue
        parts = [htmllib.unescape(p).strip() for p in re.split(r"<[^>]+>", m.group(2))]
        parts = [p for p in parts if p and p != ":"]
        if len(parts) < 2:
            continue
        cards.append({"slug": slug, "employer": parts[0], "title": parts[1],
                      "city": parts[2] if len(parts) > 2 and not re.search(r"\d+\s*uur", parts[2]) else None})
    plain = re.sub(r"<[^>]+>", " ", markup)
    total = re.search(r"\bVacatures\s+(\d+)\b", plain)
    return cards, int(total.group(1)) if total else None


def parse_wbh_detail(markup, url, card):
    lines = to_text(markup).splitlines()
    text = "\n".join(lines)
    rec = {"url": url, "title": card["title"], "employer": card["employer"], "city": card.get("city")}
    d = re.search(r"Geplaatst:\s*(\d{1,2})\s+([a-z]+)\s+(\d{4})", text, re.I)
    rec["published"] = (parse_nl_date(*d.groups()) or None) if d else None
    d = re.search(r"Sluitingsdatum:\s*(\d{1,2})\s+([a-z]+)\s+(\d{4})", text, re.I)
    rec["deadline"] = (parse_nl_date(*d.groups()) or None) if d else None
    for k in ("published", "deadline"):
        rec[k] = rec[k].isoformat() if rec[k] else None
    meta = next((ln for ln in lines if re.search(r"\d+(?:[,.]\d+)?\s*uur\b", ln) and len(ln) < 160), "")
    h = re.search(r"(\d+(?:[,.]\d+)?)\s*(?:[-–]\s*(\d+(?:[,.]\d+)?))?\s*uur", meta)
    rec["hours"] = [to_float(h.group(1)), to_float(h.group(2) or h.group(1))] if h else None
    c = re.search(r"(Tijdelijk(?: met uitzicht op vast)?|Vast|Onbepaalde tijd|Bepaalde tijd)", meta)
    rec["contract"] = c.group(1) if c else None
    sal = re.search(r"€\s?([\d.]+(?:,\d+)?)\s*(?:en|tot|-|–)\s*(?:maximaal\s*)?€\s?([\d.]+(?:,\d+)?)", text)
    if sal:
        lo, hi = (float(x.replace(".", "").replace(",", ".")) for x in sal.groups())
        rec["salary"] = f"{fmt_eur(lo)} – {fmt_eur(hi)} per maand (voltijd)"
    else:
        rec["salary"] = None
    return rec


def crawl_wbh(cfg, rules, existing, rejected, today, fetch=fetch_text, sleep=time.sleep):
    """Loopt de overzichtspagina's af en haalt alleen nieuwe, passende vacatures op.
    Geeft (nieuw, gezien, aantal kandidaten, compleet) terug; 'compleet' is False als een pagina mislukte."""
    include = re.compile(cfg.get("extra_include", "$^") + "|" + rules["include"].pattern, re.I)
    delay = cfg.get("crawl_delay", 3)
    seen, cards, complete, total = set(), [], True, None
    for page in range(1, cfg.get("max_pages", 30) + 1):
        if page > 1:
            sleep(delay)
        try:
            found, total = parse_wbh_listing(fetch(f"{WBH_BASE}/vacatures?page={page}"))
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            print(f"  ! overzicht pagina {page} mislukt ({exc})")
            complete = False
            break
        fresh = [c for c in found if f"wbh-{c['slug']}" not in seen]
        if not fresh:
            break
        for c in fresh:
            seen.add(f"wbh-{c['slug']}")
        cards += fresh
        if total and len(seen) >= total:
            break
    if total and len(seen) < total:
        complete = False
    candidates = [c for c in cards if include.search(c["slug"]) or include.search(c["title"])]
    new, fetched = [], 0
    for c in candidates:
        rid = f"wbh-{c['slug']}"
        if rid in existing or rid in rejected or fetched >= cfg.get("max_new_pages", 25):
            continue
        if not accept_title(c["title"], rules, c["employer"]):
            rejected[rid] = "buiten bereik: " + c["title"][:60]
            continue
        sleep(delay)
        fetched += 1
        url = f"{WBH_BASE}/vacatures/{c['slug']}"
        try:
            rec = parse_wbh_detail(fetch(url), url, c)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            print(f"  ! {rid}: ophalen mislukt ({exc})")
            continue
        r = make_record(rid, cfg["name"], rec, today)
        r["contract"] = rec.get("contract")
        r["in_sitemap"] = True
        new.append(r)
    return new, seen, len(candidates), complete


# ------------------------------------------------------------------ RSS
def _child_text(el, name):
    for c in el:
        if c.tag.split("}")[-1] == name and c.text:
            return c.text.strip()
    return None


def parse_rss(xml_text):
    root = ET.fromstring(xml_text)
    out = []
    for el in root.iter():
        if el.tag.split("}")[-1] not in ("item", "entry"):
            continue
        link = _child_text(el, "link")
        if not link:
            for c in el:
                if c.tag.split("}")[-1] == "link" and c.get("href"):
                    link = c.get("href")
                    break
        out.append({"title": _child_text(el, "title"), "link": link,
                    "date": _child_text(el, "pubDate") or _child_text(el, "published") or _child_text(el, "updated")})
    return [o for o in out if o["title"] and o["link"]]


def crawl_rss(cfg, rules, existing, rejected, today, fetch=fetch_text):
    flt = re.compile(cfg.get("title_filter", "."), re.I)
    new = []
    items = parse_rss(fetch(cfg["url"]))
    for it in items:
        rid = "rss-" + hashlib.sha1(it["link"].encode()).hexdigest()[:10]
        if rid in existing or rid in rejected:
            continue
        if not flt.search(it["title"]) or not accept_title(it["title"], rules, cfg.get("employer")):
            rejected[rid] = "buiten bereik: " + it["title"][:60]
            continue
        rec = {"title": it["title"], "employer": cfg.get("employer"), "city": cfg.get("city"),
               "hours": None, "salary": None, "published": None, "deadline": None, "url": it["link"]}
        new.append(make_record(rid, cfg["name"], rec, today))
    return new, {r["id"] for r in existing.values() if r["source"] == cfg["name"]} | {
        "rss-" + hashlib.sha1(i["link"].encode()).hexdigest()[:10] for i in items}, len(items)


# ------------------------------------------------------------- records
def make_record(rid, source, rec, today):
    out = {
        "id": rid, "source": source, "url": rec["url"], "title": rec["title"],
        "employer": rec.get("employer"), "city": rec.get("city"),
        "hours": rec.get("hours"), "salary": rec.get("salary"), "contract": None,
        "published": rec.get("published"), "deadline": rec.get("deadline"),
        "topics": topics_for(rec["title"]), "summary": None,
        "first_seen": today.isoformat(), "last_seen": today.isoformat(),
        "in_sitemap": True if source == "AcademicTransfer" else None,
        "closed_early": False, "archive_url": None, "archive_requested": None,
    }
    return out


# Hoofdvestiging als de vacature zelf geen adres noemt (alleen gebruikt bij ontbrekende plaats).
EMPLOYER_CITY = [
    ("delft university|tu delft|technische universiteit delft", "Delft"),
    ("eindhoven university|tu eindhoven|technische universiteit eindhoven", "Eindhoven"),
    ("universiteit utrecht|utrecht university|hogeschool utrecht", "Utrecht"),
    ("universiteit leiden|leiden university", "Leiden"),
    ("wageningen", "Wageningen"),
    ("universiteit van amsterdam|uva\\b|hogeschool van amsterdam|vrije universiteit", "Amsterdam"),
    ("tilburg", "Tilburg"),
    ("maastricht", "Maastricht"),
    ("universiteit twente|university of twente", "Enschede"),
    ("rijksuniversiteit groningen|hanzehogeschool", "Groningen"),
    ("radboud", "Nijmegen"),
    ("erasmus", "Rotterdam"),
    ("open universiteit", "Heerlen"),
]


def city_from_employer(name):
    low = (name or "").lower()
    for pat, city in EMPLOYER_CITY:
        if re.search(pat, low):
            return city
    return None


def enrich(item):
    """Vul coördinaten aan op basis van de plaats."""
    if not item.get("city"):
        item["city"] = city_from_employer(item.get("employer"))
    xy = coords_for(item.get("city"))
    if xy:
        item["lat"], item["lon"] = xy
        item["city"] = display_city(item["city"])
    else:
        item.pop("lat", None)
        item.pop("lon", None)
    return item


def employer_key(name, employers):
    """Koppel een werkgeversnaam aan een profiel via de beginwoorden (aliases)."""
    if not name:
        return None
    base = re.sub(r"\s*\(.*?\)", "", name).strip().lower()
    for key, prof in employers.items():
        for alias in prof.get("aliases", []):
            if re.match(rf"{re.escape(alias)}\b", base):
                return key
    return None


def apply_closed_state(items, seen_ids, today, source="AcademicTransfer"):
    """Markeer vacatures die uit de sitemap verdwenen zijn vóór hun sluitdatum."""
    for it in items:
        if it["source"] != source:
            continue
        if it["id"] in seen_ids:
            it["in_sitemap"] = True
            it["closed_early"] = False
            it["last_seen"] = today.isoformat()
        else:
            gone = it.get("in_sitemap") is not False
            it["in_sitemap"] = False
            deadline = it.get("deadline")
            if gone and deadline and deadline >= today.isoformat():
                it["closed_early"] = True


def request_archive(url, timeout=60):
    """Vraag het Internet Archive om een kopie van de pagina. Mislukken is niet erg."""
    req = urllib.request.Request("https://web.archive.org/save/" + url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read(1)
        return True
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def archive_pending(items, today, requester=request_archive, sleep=time.sleep):
    done = 0
    for it in sorted(items, key=lambda x: x.get("deadline") or "9999"):
        if it.get("archive_requested") or done >= MAX_ARCHIVE_PER_RUN:
            continue
        if done:
            sleep(6)
        done += 1
        if requester(it["url"]):
            it["archive_requested"] = today.isoformat()
            it["archive_url"] = "https://web.archive.org/web/" + it["url"]
    return done


# ---------------------------------------------------------------- main
def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save(doc):
    doc["items"].sort(key=lambda x: (x.get("deadline") or "", x["id"]), reverse=True)
    (DATA / "vacancies.json").write_text(
        json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


# ------------------------------------------------------------------ versleuteld tekstarchief
_NOISE = re.compile(r"(?i)^(solliciteer nu.*|solliciteer direct.*|apply now.*|opslaan|vacature opslaan|toevoegen aan favorieten|"
                    r"save( job)?|bekijk op google maps|view on google maps)$")


def extract_body(text, title=None):
    """Knip de vacaturetekst uit een AcademicTransfer-pagina: van de titel tot 'Over deze werkgever'.
    Valt terug op de hele paginatekst als de markeringen ontbreken."""
    lines = text.splitlines()
    start = next((i for i, ln in enumerate(lines) if re.match(r"(?i)^deadline\b", ln)), None)
    if start is not None and start > 0:
        start -= 1  # de titelregel staat direct boven 'Deadline'
    if start is None:  # Werken bij hogescholen
        start = next((i + 1 for i, ln in enumerate(lines) if ln == "Terug naar vacatures"), None)
    end = next((i for i, ln in enumerate(lines)
                if re.match(r"(?i)^(over deze werkgever|about this employer|deel vacature\b.*)$", ln)), None)
    if start is None or end is None or end <= start:
        return text
    return "\n".join(ln for ln in lines[start:end] if not _NOISE.match(ln))


def encrypt_text(plain, public_spki_b64):
    """Versleutel met een eigen AES-256-GCM-sleutel, die zelf met RSA-OAEP (publieke sleutel) wordt versleuteld."""
    import base64
    import os
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    pub = serialization.load_der_public_key(base64.b64decode(public_spki_b64))
    key, iv = AESGCM.generate_key(bit_length=256), os.urandom(12)
    ct = AESGCM(key).encrypt(iv, plain.encode("utf-8"), None)
    wk = pub.encrypt(key, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    b = lambda x: base64.b64encode(x).decode()
    return {"wk": b(wk), "iv": b(iv), "ct": b(ct)}


def archive_texts(items, today, archive_dir=TEXT_ARCHIVE, key_file=DATA / "archive-key.json",
                  fetch=fetch_text, sleep=time.sleep, delay=10, limit=25):
    """Haal de volledige vacaturetekst op zolang de pagina bestaat en bewaar die versleuteld.
    Alleen wie de wachtwoordzin heeft kan de teksten lezen; in de openbare repo staat alleen versleutelde data."""
    try:
        import cryptography  # noqa: F401
    except ImportError:
        print("  ! tekstarchief overgeslagen: pakket 'cryptography' ontbreekt")
        return 0
    pub = load_json(key_file)["public_spki"]
    archive_dir = Path(archive_dir)
    archive_dir.mkdir(parents=True, exist_ok=True)
    todo = [it for it in items if it.get("url") and not (archive_dir / f"{it['id']}.json").exists()]
    todo.sort(key=lambda it: ((it.get("deadline") or "9999") < today.isoformat(), it["id"]))
    saved = 0
    for n, it in enumerate(todo[:limit]):
        if n:
            sleep(delay)
        try:
            text = to_text(fetch(it["url"]))
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            print(f"  ! tekst {it['id']}: ophalen mislukt ({exc})")
            continue
        body = extract_body(text, it.get("title"))
        if len(body) < 300:
            print(f"  ! tekst {it['id']}: te kort, overgeslagen")
            continue
        head = (f"{it['title']}\n{it.get('employer') or ''}\nBron: {it['url']}\n"
                f"Opgehaald: {today.isoformat()}\n\n")
        rec = {"v": 1, "id": it["id"], "saved": today.isoformat()}
        rec.update(encrypt_text(head + body, pub))
        (archive_dir / f"{it['id']}.json").write_text(json.dumps(rec), encoding="utf-8")
        it["text_saved"] = today.isoformat()
        saved += 1
    return saved


def mark_saved_texts(items, archive_dir=TEXT_ARCHIVE):
    for it in items:
        f = Path(archive_dir) / f"{it['id']}.json"
        if f.exists() and not it.get("text_saved"):
            it["text_saved"] = json.loads(f.read_text(encoding="utf-8")).get("saved")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    offline = "--offline" in argv
    from zoneinfo import ZoneInfo
    now = dt.datetime.now(ZoneInfo("Europe/Amsterdam"))
    today = now.date()
    doc = load_json(DATA / "vacancies.json")
    cfg = load_json(DATA / "sources.json")
    rules = compile_rules(cfg)
    meta = doc.setdefault("meta", {})
    meta.setdefault("sources", {})
    rejected = meta.setdefault("rejected", {})
    existing = {it["id"]: it for it in doc["items"]}
    failures = enabled = 0

    if not offline:
        for src in cfg["sources"]:
            if not src.get("enabled"):
                continue
            enabled += 1
            status = {"ok": False, "found": 0, "new": 0, "error": None, "checked": now.isoformat(timespec="seconds")}
            try:
                if src["type"] == "academictransfer":
                    new, seen, found = crawl_academictransfer(src, rules, existing, rejected, today)
                    apply_closed_state(doc["items"], seen, today, source=src["name"])
                elif src["type"] == "werkenbijhogescholen":
                    new, seen, found, complete = crawl_wbh(src, rules, existing, rejected, today)
                    if complete:
                        apply_closed_state(doc["items"], seen, today, source=src["name"])
                    else:
                        print(f"  ! {src['name']}: overzicht onvolledig, sluitstatus niet bijgewerkt")
                elif src["type"] == "rss":
                    new, _seen, found = crawl_rss(src, rules, existing, rejected, today)
                else:
                    raise ValueError("onbekend brontype " + src["type"])
                for rec in new:
                    doc["items"].append(rec)
                    existing[rec["id"]] = rec
                status.update(ok=True, found=found, new=len(new))
                print(f"{src['name']}: {found} kandidaten, {len(new)} nieuw")
            except Exception as exc:  # een mislukte bron mag de rest niet stoppen
                failures += 1
                status["error"] = f"{type(exc).__name__}: {exc}"[:200]
                print(f"{src['name']}: MISLUKT ({status['error']})")
            meta["sources"][src["name"]] = status
        meta["updated"] = now.isoformat(timespec="seconds")
        n = archive_pending(doc["items"], today)
        print(f"Archiefverzoeken: {n}")
        print(f"Teksten versleuteld bewaard: {archive_texts(doc['items'], today)}")

    mark_saved_texts(doc["items"])
    employers = load_json(DATA / "employers.json")["employers"]
    missing = set()
    for it in doc["items"]:
        enrich(it)
        it["employer_key"] = employer_key(it.get("employer"), employers)
        if not it["employer_key"] and it.get("employer"):
            missing.add(it["employer"])
    meta["employers_missing"] = sorted(missing)
    if missing:
        print("Werkgevers zonder profiel: " + "; ".join(sorted(missing)))
    if len(rejected) > MAX_REJECTED:
        for k in list(rejected)[: len(rejected) - MAX_REJECTED]:
            rejected.pop(k)
    save(doc)
    print(f"Totaal {len(doc['items'])} vacatures opgeslagen.")
    return 2 if enabled and failures == enabled else 0


if __name__ == "__main__":
    sys.exit(main())
