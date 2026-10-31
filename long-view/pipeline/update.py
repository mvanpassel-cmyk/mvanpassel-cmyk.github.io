#!/usr/bin/env python3
"""The Long View: daily selection of news with lasting significance.

1. Fetch a broad set of RSS/Atom feeds (data/feeds.json).
2. Keep items from the last few days that we have not seen before.
3. Ask Claude to act as editor: pick at most a handful that will still matter
   in 50+ years, with a time horizon, theme, neutral headline and one-line "why".
4. Append picks to data/stories.json and write data/status.json.

Standard library only. Needs ANTHROPIC_API_KEY (GitHub secret); without it the
script fetches and reports, but adds nothing.
"""
import hashlib, html, json, os, re, sys, time, urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
UA = "Mozilla/5.0 (compatible; LongViewBot/1.0; +https://mvanpassel-cmyk.github.io/long-view/)"
MODEL = os.environ.get("LONG_VIEW_MODEL", "claude-sonnet-5-5")
MAX_PICKS = int(os.environ.get("LONG_VIEW_MAX_PICKS", "4"))
MIN_SCORE = int(os.environ.get("LONG_VIEW_MIN_SCORE", "80"))
WINDOW_DAYS = 4
SEEN_KEEP_DAYS = 90
MAX_CANDIDATES = 220
HORIZONS = ["decades", "centuries", "millennia"]
THEMES = ["Climate", "Nature", "Health", "Science", "Technology", "Space", "Energy", "Society", "Governance"]


def load(name, default):
    try:
        with open(os.path.join(DATA, name), encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save(name, obj):
    path = os.path.join(DATA, name)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, path)


def key(url):
    u = re.sub(r"[?#].*$", "", url.strip().lower()).rstrip("/")
    return hashlib.sha1(u.encode()).hexdigest()[:16]


def clean(s, n=320):
    s = html.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= n else s[: n - 1].rsplit(" ", 1)[0] + "…"


def parse_date(s):
    if not s:
        return None
    s = s.strip()
    try:
        d = parsedate_to_datetime(s)
    except (TypeError, ValueError):
        d = None
    if d is None:
        try:
            d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc)


def local(tag):
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def child(el, *names):
    for c in el:
        if local(c.tag) in names:
            return c
    return None


def parse_feed(xml_bytes):
    """RSS 2.0, RSS 1.0 (RDF) or Atom -> list of {title,url,summary,date}."""
    root = ET.fromstring(xml_bytes)
    out = []
    for el in root.iter():
        name = local(el.tag)
        if name not in ("item", "entry"):
            continue
        t = child(el, "title")
        title = clean(t.text if t is not None else "", 220)
        url = ""
        if name == "entry":
            for l in el:
                if local(l.tag) == "link" and l.get("rel", "alternate") == "alternate" and l.get("href"):
                    url = l.get("href"); break
        if not url:
            l = child(el, "link")
            if l is not None:
                url = (l.text or l.get("href") or "").strip()
        if not url:
            g = child(el, "guid")
            if g is not None and (g.text or "").startswith("http"):
                url = g.text.strip()
        d = child(el, "description", "summary", "content", "encoded")
        dt = child(el, "pubDate", "published", "updated", "date")
        if title and url.startswith("http"):
            out.append({"title": title, "url": url, "summary": clean(d.text if d is not None else ""),
                        "date": parse_date(dt.text if dt is not None else "")})
    return out


def fetch(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA,
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def ask_claude(candidates, recent_headlines):
    lines = []
    for i, c in enumerate(candidates):
        lines.append(f"[{i}] {c['source']} | {c['title']} | {c['summary'][:260]}")
    system = (
        "You are the editor of The Long View, a news page in the spirit of Kirk Citron's 'The Long News': "
        "it keeps only stories that people will still find significant in 50, 100 or 1,000 years. "
        "Ignore the daily churn: elections, markets, celebrities, scandals, sport, single disasters, ordinary policy fights, "
        "product launches, and incremental studies. Look for turning points and long arcs: firsts in science and exploration, "
        "irreversible shifts in climate, ecosystems or demography, durable treaties and institutions, changes in how humans live, "
        "die, work or think, technologies that alter what is possible, and the end of something old. "
        "Most days only zero to two stories qualify; returning none is a correct answer. "
        "Never pick two items about the same development, and skip anything already covered in the recent list."
    )
    user = (
        f"Recent picks (do not repeat these developments):\n- " + "\n- ".join(recent_headlines[:60]) +
        f"\n\nToday's candidates:\n" + "\n".join(lines) +
        f"\n\nReturn JSON only, no prose: {{\"picks\":[{{\"i\":<index>,\"score\":<0-100 lasting significance>,"
        f"\"horizon\":\"decades|centuries|millennia\",\"theme\":\"one of {', '.join(THEMES)}\","
        f"\"headline\":\"neutral headline in your own words, max 12 words\","
        f"\"why\":\"one sentence in your own words, max 32 words, on why this will still matter in 50+ years\"}}]}}. "
        f"Pick at most {MAX_PICKS}. Only include items scoring {MIN_SCORE} or more. "
        "Use 'decades' for shifts that shape the next 50-100 years, 'centuries' for changes that will define an era, "
        "'millennia' only for the rare event that changes humanity's or the planet's long trajectory."
    )
    body = json.dumps({"model": MODEL, "max_tokens": 2000, "system": system,
                       "messages": [{"role": "user", "content": user}]}).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, headers={
        "x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01",
        "content-type": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                res = json.load(r)
            text = "".join(b.get("text", "") for b in res.get("content", []) if b.get("type") == "text")
            return parse_picks(text, len(candidates))
        except Exception as e:  # network or overload: retry briefly
            print(f"Claude call failed ({e}); attempt {attempt + 1}/3", file=sys.stderr)
            time.sleep(8 * (attempt + 1))
    raise RuntimeError("Claude API unavailable")


def parse_picks(text, n):
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return []
    try:
        obj = json.loads(m.group(0))
    except json.JSONDecodeError:
        return []
    picks, used = [], set()
    for p in obj.get("picks", []):
        try:
            i, score = int(p["i"]), int(p["score"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (0 <= i < n) or i in used or score < MIN_SCORE:
            continue
        hz = p.get("horizon") if p.get("horizon") in HORIZONS else "decades"
        th = p.get("theme") if p.get("theme") in THEMES else "Society"
        head, why = clean(p.get("headline", ""), 120), clean(p.get("why", ""), 260)
        if not head or not why:
            continue
        used.add(i)
        picks.append({"i": i, "score": score, "horizon": hz, "theme": th, "headline": head, "why": why})
    picks.sort(key=lambda p: -p["score"])
    return picks[:MAX_PICKS]


def main():
    now = datetime.now(timezone.utc)
    feeds = load("feeds.json", [])
    stories = load("stories.json", [])
    seen = load("seen.json", {})
    have = {s["id"] for s in stories}
    status = {"last_run": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "feeds_ok": 0, "feeds_failed": [],
              "candidates": 0, "picked": 0, "ai": bool(os.environ.get("ANTHROPIC_API_KEY")), "model": MODEL}

    cutoff = now - timedelta(days=WINDOW_DAYS)
    cands, fresh_keys = [], []
    for f in feeds:
        try:
            items = parse_feed(fetch(f["url"]))
            status["feeds_ok"] += 1
        except Exception as e:
            status["feeds_failed"].append(f["name"])
            print(f"feed failed: {f['name']}: {e}", file=sys.stderr)
            continue
        for it in items[:40]:
            k = key(it["url"])
            if k in seen or k in have:
                continue
            if it["date"] and it["date"] < cutoff:
                continue
            it.update(source=f["name"], id=k)
            cands.append(it)
            fresh_keys.append(k)

    # spread the budget over sources so one busy feed cannot crowd out the rest
    per = {}
    trimmed = []
    for c in sorted(cands, key=lambda c: c["date"] or now, reverse=True):
        per[c["source"]] = per.get(c["source"], 0) + 1
        if per[c["source"]] <= 18:
            trimmed.append(c)
    cands = trimmed[:MAX_CANDIDATES]
    status["candidates"] = len(cands)

    picks = []
    if not status["ai"]:
        status["note"] = "No ANTHROPIC_API_KEY secret set: candidates fetched, nothing selected."
        print(status["note"])
    elif cands:
        recent = [s["headline"] for s in stories[:60]]
        picks = ask_claude(cands, recent)
        for p in picks:
            c = cands[p["i"]]
            stories.insert(0, {"id": c["id"], "date": (c["date"] or now).strftime("%Y-%m-%d"),
                               "added": now.strftime("%Y-%m-%d"), "headline": p["headline"], "title": c["title"],
                               "url": c["url"], "source": c["source"], "horizon": p["horizon"], "theme": p["theme"],
                               "score": p["score"], "why": p["why"]})
        status["picked"] = len(picks)

    # only remember candidates as seen when an editor actually looked at them
    if status["ai"]:
        for k in fresh_keys:
            seen[k] = now.strftime("%Y-%m-%d")
    keep_after = (now - timedelta(days=SEEN_KEEP_DAYS)).strftime("%Y-%m-%d")
    seen = {k: d for k, d in seen.items() if d >= keep_after}

    stories.sort(key=lambda s: (s["date"], s.get("score", 0)), reverse=True)
    save("stories.json", stories[:3000])
    save("seen.json", seen)
    save("status.json", status)
    print(json.dumps(status, indent=1))


if __name__ == "__main__":
    main()
