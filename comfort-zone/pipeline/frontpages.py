#!/usr/bin/env python3
"""Comfort Zone: today's health front page of ~60 countries.

Fetches the Google News 'Health' section of each country edition (editions.json),
in that country's own language, and keeps the top headlines. Free, no API key.
The page picks the editions furthest from what you usually read.
Standard library only.
"""
import html, json, os, re, sys, time, urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "data", "frontpages.json")
UA = "Mozilla/5.0 (compatible; ComfortZoneBot/1.0; +https://mvanpassel-cmyk.github.io/comfort-zone/)"
KEEP = 8


def feed_url(hl, gl, ceid):
    return f"https://news.google.com/rss/headlines/section/topic/HEALTH?hl={hl}&gl={gl}&ceid={ceid}"


def clean(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def split_publisher(title):
    m = re.match(r"^(.*)\s+-\s+([^-]{2,60})$", title or "")
    return (m.group(1).strip(), m.group(2).strip()) if m else (title, "")


def parse(xml_bytes, keep=KEEP):
    out, seen = [], set()
    for it in ET.fromstring(xml_bytes).iter("item"):
        head, pub = split_publisher(clean(it.findtext("title")))
        link = (it.findtext("link") or "").strip()
        src = clean(it.findtext("source")) or pub
        if not head or not link.startswith("http") or head.lower() in seen:
            continue
        seen.add(head.lower())
        try:
            date = parsedate_to_datetime(it.findtext("pubDate")).astimezone(timezone.utc).strftime("%Y-%m-%d")
        except Exception:  # noqa: BLE001
            date = ""
        out.append({"title": head[:240], "src": src[:60], "url": link, "date": date})
        if len(out) >= keep:
            break
    return out


def main():
    editions = json.load(open(os.path.join(HERE, "editions.json"), encoding="utf-8"))
    prev = {}
    try:
        prev = {e["gl"]: e for e in json.load(open(OUT, encoding="utf-8")).get("editions", [])}
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    out, failed = [], []
    for gl, iso3, name, hl, ceid in editions:
        try:
            req = urllib.request.Request(feed_url(hl, gl, ceid), headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                items = parse(r.read())
        except Exception as e:  # noqa: BLE001
            items = []
            failed.append(f"{gl}: {type(e).__name__}")
        if not items and gl in prev:          # keep yesterday's page rather than an empty one
            items = prev[gl]["items"]
        if items:
            out.append({"gl": gl, "iso3": iso3, "name": name, "lang": hl.split("-")[0], "items": items})
        time.sleep(0.5)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                   "editions": out, "failed": failed}, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"{len(out)} editions, {sum(len(e['items']) for e in out)} headlines; failed: {failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
