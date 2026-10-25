#!/usr/bin/env python3
"""Risk Radar ingestion pipeline (standard library only).

Runs daily in GitHub Actions. For every source in data/sources.json that has a
`connector`, it fetches the feed or publication page, detects items that are new
since the previous run, matches them to canonical risks by keyword, and writes:

  data/signals.json    detected items (newest first), with detection time
  data/status.json     per-source check result, last success, newest item
  data/changelog.json  one line per run per source with new items
  data/feed.xml        Atom feed of material updates (detected + curated)

Design rules:
- A failing source never erases earlier items; its status shows the error.
- The first successful check of a source is stored as a baseline and not
  announced as "new", so adding a source does not flood the feed.
- Items are identified by a hash of their normalised URL, so a changed page
  timestamp or reordered list does not create phantom updates.
- robots.txt is respected; fetched content is treated as data only.
"""
import datetime as dt
import hashlib
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import urllib.robotparser
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
UA = "RiskRadarBot/1.0 (+https://mvanpassel-cmyk.github.io/risk-radar/; research dashboard)"
TIMEOUT = 25
MAX_SIGNALS = 600
SITE = "https://mvanpassel-cmyk.github.io/risk-radar/"


# ---------------------------------------------------------------- helpers
def now_iso():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load(name, default):
    try:
        with open(os.path.join(DATA, name), encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save(name, obj):
    path = os.path.join(DATA, name)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def norm_url(url):
    """Normalise a URL for identity: lower-case host, drop fragment, tracking params and trailing slash."""
    p = urllib.parse.urlsplit(url.strip())
    q = [(k, v) for k, v in urllib.parse.parse_qsl(p.query) if not k.lower().startswith(("utm_", "rand")) and k.lower() not in ("fbclid", "gclid")]
    path = re.sub(r"/+$", "", p.path) or "/"
    return urllib.parse.urlunsplit((p.scheme.lower() or "https", p.netloc.lower(), path, urllib.parse.urlencode(q), ""))


def item_id(url):
    return hashlib.sha1(norm_url(url).encode()).hexdigest()[:16]


def clean(text, limit=None):
    text = html.unescape(re.sub(r"<[^>]+>", " ", text or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit] if limit else text


def parse_date(s):
    """Return ISO date-time (UTC) or None. Accepts RFC 822 and ISO 8601."""
    if not s:
        return None
    s = s.strip()
    from email.utils import parsedate_to_datetime
    try:
        d = parsedate_to_datetime(s)
    except (TypeError, ValueError):
        d = None
    if d is None:
        try:
            d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------- fetching
_robots = {}


def allowed(url):
    p = urllib.parse.urlsplit(url)
    base = f"{p.scheme}://{p.netloc}"
    if base not in _robots:
        rp = urllib.robotparser.RobotFileParser()
        try:
            req = urllib.request.Request(base + "/robots.txt", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                rp.parse(r.read().decode("utf-8", "replace").splitlines())
        except Exception:
            rp = None  # no robots.txt reachable: treat as allowed
        _robots[base] = rp
    rp = _robots[base]
    return True if rp is None else rp.can_fetch(UA, url)


def fetch(url):
    if not allowed(url):
        raise PermissionError("disallowed by robots.txt")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read()


# ---------------------------------------------------------------- parsing
def _local(tag):
    return tag.rsplit("}", 1)[-1].lower()


def parse_feed(raw):
    """Parse RSS 2.0, RSS 1.0 (RDF) or Atom into a list of dicts."""
    if isinstance(raw, bytes):
        raw = raw.lstrip(b"\xef\xbb\xbf")
    root = ET.fromstring(raw)
    items = []
    for el in root.iter():
        name = _local(el.tag)
        if name not in ("item", "entry"):
            continue
        rec = {"title": "", "url": "", "published": None, "summary": ""}
        for ch in el:
            n = _local(ch.tag)
            if n == "title":
                rec["title"] = clean("".join(ch.itertext()), 300)
            elif n == "link":
                href = ch.get("href")
                if href and (ch.get("rel") in (None, "alternate")):
                    rec["url"] = rec["url"] or href.strip()
                elif not href and (ch.text or "").strip():
                    rec["url"] = ch.text.strip()
            elif n in ("guid", "id") and not rec["url"] and (ch.text or "").startswith("http"):
                rec["url"] = ch.text.strip()
            elif n in ("pubdate", "published", "updated", "date", "issued"):
                rec["published"] = rec["published"] or parse_date(ch.text)
            elif n in ("description", "summary", "content", "encoded"):
                rec["summary"] = rec["summary"] or clean("".join(ch.itertext()), 400)
        if rec["url"] and rec["title"]:
            items.append(rec)
    return items


def parse_who_api(raw, item_base):
    """WHO OData API (e.g. /api/news/diseaseoutbreaknews): {'value': [{Title, PublicationDate..., UrlName|ItemDefaultUrl}]}."""
    data = json.loads(raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw)
    rows = data.get("value", data if isinstance(data, list) else [])
    out = []
    for r in rows:
        title = clean(r.get("Title") or r.get("title") or "", 300)
        slug = r.get("UrlName") or r.get("ItemDefaultUrl") or r.get("Url") or ""
        url = slug if slug.startswith("http") else (item_base.rstrip("/") + "/" + slug.lstrip("/")) if slug else ""
        pub = parse_date(r.get("PublicationDateAndTime") or r.get("PublicationDate") or r.get("DateCreated") or "")
        summ = clean(r.get("Summary") or r.get("Overview") or "", 400)
        if title and url:
            out.append({"title": title, "url": url, "published": pub, "summary": summ})
    return out


HREF = re.compile(r'<a\b[^>]*?href=["\']([^"\'#]+)["\'][^>]*>(.*?)</a>', re.I | re.S)


def parse_page(raw, base_url, pattern):
    """Extract publication links matching `pattern` from an HTML listing page."""
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
    rx = re.compile(pattern, re.I)
    seen, out = set(), []
    for href, label in HREF.findall(text):
        url = urllib.parse.urljoin(base_url, html.unescape(href))
        if not rx.search(urllib.parse.urlsplit(url).path):
            continue
        k = norm_url(url)
        if k in seen:
            continue
        seen.add(k)
        title = clean(label, 300) or url.rstrip("/").rsplit("/", 1)[-1].replace("-", " ")
        out.append({"title": title, "url": url, "published": None, "summary": ""})
    return out


def content_hash(items):
    """Hash of the set of item identities only, so cosmetic page changes do not count as updates."""
    return hashlib.sha1("\n".join(sorted(item_id(i["url"]) for i in items)).encode()).hexdigest()


# ---------------------------------------------------------------- matching
def build_matchers(risks):
    out = []
    for r in risks:
        terms = [t for t in r.get("match", []) if t.strip()]
        if not terms:
            continue
        rx = re.compile(r"(?<![\w-])(" + "|".join(re.escape(t) for t in sorted(terms, key=len, reverse=True)) + r")(?![\w-])", re.I)
        out.append((r["id"], rx))
    return out


def match_risks(text, matchers):
    return [rid for rid, rx in matchers if rx.search(text or "")]


# ---------------------------------------------------------------- connectors
def run_connector(src):
    c = src["connector"]
    if c["type"] == "rss":
        items, errors = [], []
        for url in c["urls"]:
            try:
                got = parse_feed(fetch(url))
                items.extend(got)
                if not c.get("merge"):
                    break
            except Exception as e:  # try the next candidate URL
                errors.append(f"{url}: {type(e).__name__}: {e}"[:200])
        if not items and errors:
            raise RuntimeError("; ".join(errors))
        if c.get("filter"):
            rx = re.compile(c["filter"], re.I)
            items = [i for i in items if rx.search(i["title"])]
        return items, None
    if c["type"] == "json":
        return parse_who_api(fetch(c["url"]), c.get("itemBase", "")), None
    if c["type"] == "page":
        items = parse_page(fetch(c["url"]), c["url"], c["link"])
        if not items:
            raise RuntimeError("page fetched but no publication links matched; layout may have changed")
        return items, content_hash(items)
    raise ValueError(f"unknown connector type {c['type']}")


def merge_items(src, items, prev_state, signals, matchers, detected, baseline):
    """Add unseen items to signals. Returns the number of new (announced) items."""
    known = set(prev_state.get("seen", []))
    existing = {s["id"] for s in signals}
    new = 0
    for it in items:
        iid = item_id(it["url"])
        if iid in known or iid in existing:
            continue
        rids = match_risks(it["title"] + " " + it["summary"], matchers)
        signals.append({
            "id": iid, "source": src["id"], "title": it["title"], "url": it["url"],
            "published": it.get("published"), "detected": detected,
            "label": "New report", "riskIds": rids, "match": "keywords (unreviewed)" if rids else None,
            "baseline": baseline,
        })
        known.add(iid)
        if not baseline:
            new += 1
    prev_state["seen"] = sorted(known)[-2000:]
    return new


# ---------------------------------------------------------------- feed
def atom(entries, updated):
    esc = lambda s: html.escape(s or "", quote=True)
    parts = ['<?xml version="1.0" encoding="utf-8"?>', '<feed xmlns="http://www.w3.org/2005/Atom">',
             "<title>Risk Radar – material updates</title>", f'<link href="{SITE}"/>', f'<link rel="self" href="{SITE}data/feed.xml"/>',
             f"<id>{SITE}</id>", f"<updated>{updated}</updated>"]
    for e in entries:
        parts += ["<entry>", f"<title>{esc(e['label'] + ': ' + e['title'])}</title>", f'<link href="{esc(e["url"])}"/>',
                  f"<id>urn:riskradar:{esc(e['id'])}</id>", f"<updated>{esc(e['detected'])}</updated>",
                  f"<summary>{esc(e.get('summaryText', ''))}</summary>", "</entry>"]
    parts.append("</feed>")
    return "\n".join(parts) + "\n"


# ---------------------------------------------------------------- main
def main():
    reg = load("sources.json", {"sources": []})["sources"]
    risks = load("risks.json", {"risks": []})["risks"]
    matchers = build_matchers(risks)
    sig = load("signals.json", {"items": []})
    signals = sig.get("items", [])
    status = load("status.json", {"sources": {}})
    state = load("state.json", {})
    changelog = load("changelog.json", {"runs": []})
    detected = now_iso()
    run_log = {"run": detected, "sources": {}}
    names = {s["id"]: s["org"] + " – " + s["series"] for s in reg}

    for src in reg:
        st = status["sources"].setdefault(src["id"], {})
        st["lastCheck"] = detected
        if not src.get("connector"):
            st.update({"ok": None, "mode": "curated", "message": "no automated connector; curated entries"})
            continue
        st["mode"] = src["connector"]["type"]
        prev = state.setdefault(src["id"], {})
        baseline = not prev.get("seen")
        try:
            items, chash = run_connector(src)
        except Exception as e:
            st.update({"ok": False, "message": f"{type(e).__name__}: {e}"[:300]})
            run_log["sources"][src["id"]] = {"ok": False}
            print(f"[FAIL] {src['id']}: {st['message']}")
            continue
        if chash and prev.get("hash") == chash:
            n = 0  # identical link set: nothing changed, skip phantom updates
        else:
            n = merge_items(src, items, prev, signals, matchers, detected, baseline)
            if chash:
                prev["hash"] = chash
        dates = [i["published"] for i in items if i.get("published")]
        st.update({"ok": True, "lastSuccess": detected, "items": len(items), "new": n,
                   "newest": max(dates) if dates else None,
                   "message": ("baseline stored" if baseline else f"{n} new") + f" · {len(items)} items read"})
        run_log["sources"][src["id"]] = {"ok": True, "new": n}
        print(f"[ OK ] {src['id']}: {st['message']}")

    signals.sort(key=lambda s: (s["detected"], s.get("published") or ""), reverse=True)
    del signals[MAX_SIGNALS:]
    save("signals.json", {"generated": detected, "items": signals})
    status["generated"] = detected
    save("status.json", status)
    save("state.json", state)
    if any(v.get("new") for v in run_log["sources"].values()) or any(not v["ok"] for v in run_log["sources"].values()):
        changelog["runs"].insert(0, run_log)
        del changelog["runs"][200:]
    save("changelog.json", changelog)

    curated = load("curated-signals.json", {"items": []})["items"]
    entries = [dict(s, summaryText=names.get(s["source"], s["source"])) for s in signals if not s.get("baseline")][:60]
    entries += [dict(c, detected=(c["date"] + "-01-01")[:10] + "T00:00:00Z" if len(c["date"]) < 10 else c["date"] + "T00:00:00Z", summaryText=c.get("text", "")) for c in curated]
    entries.sort(key=lambda e: e["detected"], reverse=True)
    with open(os.path.join(DATA, "feed.xml"), "w", encoding="utf-8") as f:
        f.write(atom(entries[:60], detected))
    failed = [k for k, v in run_log["sources"].items() if not v["ok"]]
    print(f"done: {sum(v.get('new', 0) for v in run_log['sources'].values())} new, {len(failed)} failed {failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
