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
import hashlib, html, json, os, re, sys, time, urllib.error, urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
UA = "Mozilla/5.0 (compatible; LongViewBot/1.0; +https://mvanpassel-cmyk.github.io/long-view/)"
MODEL = os.environ.get("LONG_VIEW_MODEL", "claude-sonnet-5-5")
MAX_PICKS = int(os.environ.get("LONG_VIEW_MAX_PICKS", "4"))
MIN_SCORE = int(os.environ.get("LONG_VIEW_MIN_SCORE", "80"))
WINDOW_DAYS = 9            # headlines wait in the queue this long, so a weekly editor sees the whole week
SEEN_KEEP_DAYS = 90
BATCH = 220                # headlines per Claude call
WEEK_BUDGET = int(os.environ.get("LONG_VIEW_WEEK_BUDGET", "660"))   # headlines the editor reads per week
PER_SOURCE_WEEK = 30       # so one busy feed cannot crowd out the rest
EDITOR_EVERY_DAYS = int(os.environ.get("LONG_VIEW_EDITOR_DAYS", "7"))
HORIZONS = ["years", "decades", "centuries", "millennia"]
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


def claude_request(body, timeout):
    """POST to the Messages API and return the reply text.

    Raises RuntimeError with a readable reason. Errors that a retry cannot fix
    (bad key, no credit, unknown model) fail at once, so the status line on the
    page says what to change; overload, rate limits and network errors are
    retried three times.
    """
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, headers={
        "x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01",
        "content-type": "application/json"})
    last = ""
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                res = json.load(r)
            if res.get("stop_reason") == "max_tokens":
                raise RuntimeError("Claude's reply was cut off at the token limit; the headlines stay queued.")
            return "".join(b.get("text", "") for b in res.get("content", []) if b.get("type") == "text")
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read().decode("utf-8", "replace")).get("error", {}).get("message", "")
            except Exception:  # noqa: BLE001
                msg = ""
            last = f"HTTP {e.code}" + (f": {msg[:160].rstrip('.')}" if msg else "")
            if e.code in (400, 401, 403, 404):
                raise RuntimeError(f"Claude API refused the request ({last}). Check the ANTHROPIC_API_KEY secret and the account's credit.")
        except RuntimeError:
            raise                   # a cut-off reply: retrying would only cost the same again
        except Exception as e:  # network or timeout
            last = type(e).__name__
        print(f"Claude call failed ({last}); attempt {attempt + 1}/3", file=sys.stderr)
        time.sleep(8 * (attempt + 1))
    raise RuntimeError(f"Claude API unavailable ({last}); will retry next run.")


def ask_claude(candidates, recent_headlines):
    lines = []
    for i, c in enumerate(candidates):
        lines.append(f"[{i}] {c['source']} | {c['title']} | {c['summary'][:260]}")
    system = (
        "You are the editor of The Long View, a news page in the spirit of Kirk Citron's 'The Long News': "
        "it keeps only stories that will still matter years from now, and prizes the rare ones people will still find significant in 50, 100 or 1,000 years. "
        "Ignore the daily churn: elections, markets, celebrities, scandals, sport, single disasters, ordinary policy fights, "
        "product launches, and incremental studies. Look for turning points and long arcs: firsts in science and exploration, "
        "irreversible shifts in climate, ecosystems or demography, durable treaties and institutions, changes in how humans live, "
        "die, work or think, technologies that alter what is possible, and the end of something old. "
        "Only a handful of stories a week qualify; returning none is a correct answer. "
        "Never pick two items about the same development, and skip anything already covered in the recent list."
    )
    user = (
        f"Recent picks (do not repeat these developments):\n- " + "\n- ".join(recent_headlines[:60]) +
        f"\n\nThis week's candidates:\n" + "\n".join(lines) +
        f"\n\nReturn JSON only, no prose: {{\"picks\":[{{\"i\":<index>,\"score\":<0-100 lasting significance>,"
        f"\"horizon\":\"years|decades|centuries|millennia\",\"theme\":\"one of {', '.join(THEMES)}\","
        f"\"headline\":\"neutral headline in your own words, max 12 words\","
        f"\"why\":\"one sentence in your own words, max 32 words, on why this will still matter years or generations from now\"}}]}}. "
        f"Pick at most {MAX_PICKS}. Only include items scoring {MIN_SCORE} or more. "
        "Use 'years' for developments that will clearly shape the next 1-10 years: a pandemic declared, a war begun or ended, a landmark law or treaty taking effect, a major institution changing. Ordinary news does not qualify even at this tier. "
        "Use 'decades' for shifts that shape the next 10-100 years, 'centuries' for changes that will define an era, "
        "'millennia' only for the rare event that changes humanity's or the planet's long trajectory."
    )
    body = json.dumps({"model": MODEL, "max_tokens": 16000, "system": system,
                       "messages": [{"role": "user", "content": user}]}).encode()
    return parse_picks(claude_request(body, 120), len(candidates))


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


def editor_due(prev, now, force=False):
    """The paid editor runs once every EDITOR_EVERY_DAYS; the free feed check runs daily."""
    if force or not prev.get("editor_last"):
        return True
    last = datetime.fromisoformat(prev["editor_last"].replace("Z", "+00:00"))
    return now - last >= timedelta(days=EDITOR_EVERY_DAYS) - timedelta(hours=4)


def spread(items, n):
    """Pick n items evenly across a date-sorted list, so every day of the week is represented."""
    if len(items) <= n:
        return list(items)
    return [items[int(i * len(items) / n)] for i in range(n)]


def select(queue, budget=None, per_source=PER_SOURCE_WEEK):
    """Choose the headlines the editor reads: at most per_source per feed, spread over the
    week, then round-robin across feeds up to the weekly budget. Returns newest first."""
    budget = WEEK_BUDGET if budget is None else budget
    by = {}
    for q in sorted(queue, key=lambda q: q["date"] or q["queued"]):
        by.setdefault(q["source"], []).append(q)
    lanes = [spread(v, per_source) for _, v in sorted(by.items())]
    out = []
    while len(out) < budget and any(lanes):
        for lane in lanes:
            if lane and len(out) < budget:
                out.append(lane.pop(0))
    return sorted(out, key=lambda q: q["date"] or q["queued"], reverse=True)


def to_queue(it, source, k, now):
    return {"id": k, "title": it["title"], "url": it["url"], "summary": it["summary"][:400], "source": source,
            "date": it["date"].strftime("%Y-%m-%dT%H:%M:%SZ") if it["date"] else None,
            "queued": now.strftime("%Y-%m-%dT%H:%M:%SZ")}


def from_queue(q):
    c = dict(q)
    c["date"] = datetime.fromisoformat(q["date"].replace("Z", "+00:00")) if q.get("date") else None
    return c


def main():
    now = datetime.now(timezone.utc)
    feeds = load("feeds.json", [])
    stories = load("stories.json", [])
    seen = load("seen.json", {})
    queue = load("queue.json", [])
    prev = load("status.json", {})
    have = {s["id"] for s in stories}
    queued = {q["id"] for q in queue}
    status = {"last_run": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "feeds_ok": 0, "feeds_failed": [],
              "new_items": 0, "ai": bool(os.environ.get("ANTHROPIC_API_KEY")), "model": MODEL}
    for k in ("editor_last", "editor_read", "editor_picked"):
        if k in prev:
            status[k] = prev[k]

    # 1) free, daily: add new headlines to the queue
    cutoff = now - timedelta(days=WINDOW_DAYS)
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
            if k in seen or k in have or k in queued:
                continue
            if it["date"] and it["date"] < cutoff:
                continue
            queue.append(to_queue(it, f["name"], k, now))
            queued.add(k)
            status["new_items"] += 1
    limit = cutoff.strftime("%Y-%m-%dT%H:%M:%SZ")
    queue = [q for q in queue if (q["date"] or q["queued"]) >= limit]

    # 2) paid, weekly: the editor reads a spread of the queue in batches
    if not status["ai"]:
        status["note"] = "No ANTHROPIC_API_KEY secret set: headlines are collected, nothing selected."
        print(status["note"])
    elif queue and editor_due(prev, now, os.environ.get("FORCE_EDITOR") == "true"):
        chosen = [from_queue(q) for q in select(queue)]
        recent = [s["headline"] for s in stories[:60]]
        done, picked, failed = set(), 0, False
        for b in range(0, len(chosen), BATCH):
            batch = chosen[b:b + BATCH]
            try:
                picks = ask_claude(batch, recent)
            except RuntimeError as e:   # keep the run green and say why on the page
                status["note"] = str(e)
                print(status["note"], file=sys.stderr)
                failed = True
                break
            for p in picks:
                c = batch[p["i"]]
                stories.insert(0, {"id": c["id"], "date": (c["date"] or now).strftime("%Y-%m-%d"),
                                   "added": now.strftime("%Y-%m-%d"), "headline": p["headline"], "title": c["title"],
                                   "url": c["url"], "source": c["source"], "horizon": p["horizon"], "theme": p["theme"],
                                   "score": p["score"], "why": p["why"]})
                recent.insert(0, p["headline"])
            picked += len(picks)
            done |= {c["id"] for c in batch}
        if done:
            # a finished week clears the whole queue, including headlines outside the budget;
            # after a failure only the batches the editor read are cleared
            clear = {q["id"] for q in queue} if not failed else done
            for k in clear:
                seen[k] = now.strftime("%Y-%m-%d")
            queue = [q for q in queue if q["id"] not in clear]
            status.update(editor_last=now.strftime("%Y-%m-%dT%H:%M:%SZ"), editor_read=len(done), editor_picked=picked)
    status["queued"] = len(queue)
    keep_after = (now - timedelta(days=SEEN_KEEP_DAYS)).strftime("%Y-%m-%d")
    seen = {k: d for k, d in seen.items() if d >= keep_after}

    stories.sort(key=lambda s: (s["date"], s.get("score", 0)), reverse=True)
    save("stories.json", stories[:3000])
    save("seen.json", seen)
    save("queue.json", queue)
    save("status.json", status)
    print(json.dumps(status, indent=1))


if __name__ == "__main__":
    main()
