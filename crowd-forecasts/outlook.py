#!/usr/bin/env python3
"""Weekly outlook for Wisdom of the Crows.

Joins the next six weeks of the world calendar (gh-ribbon/world-calendar) with the
crowd forecasts that fetch.mjs collected, and asks Claude, with a few web searches,
what it expects: per event a short expectation with concrete calls, its own odds
next to the crowd on the markets that matter, and a verdict on earlier calls whose
date has passed.

Every call is kept in data/calls.json and scored once it resolves (Brier score),
against the crowd's price on the same day for market questions. Market questions
are settled from the final market price when it is clear (97% or more either way);
anything else is settled by Claude with a source, or voided after 30 days.

Runs every day after fetch.mjs: settling from market prices is free and daily; the
paid Claude call runs once every EVERY_DAYS (or with FORCE_OUTLOOK=true).
Standard library only.
"""
import hashlib, json, os, re, sys, time, urllib.error, urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
MODEL = os.environ.get("CROWD_OUTLOOK_MODEL", "claude-sonnet-5-5")
CAL_URL = os.environ.get("CROWD_CALENDAR_URL",
                         "https://raw.githubusercontent.com/mvanpassel-cmyk/gh-ribbon/main/world-calendar/events.json")
WINDOW_DAYS = 42          # how far ahead the outlook looks
MARKET_DAYS = 120         # markets offered to Claude resolve within this many days
MAX_EVENTS = 30
MAX_MARKETS = 90
MAX_SEARCHES = int(os.environ.get("CROWD_OUTLOOK_SEARCHES", "5"))
EVERY_DAYS = int(os.environ.get("CROWD_OUTLOOK_DAYS", "7"))
CLEAR = 0.97              # a final market price this far to one side settles the question
VOID_AFTER_DAYS = 30
UA = "WisdomOfTheCrows/1.0 (+https://mvanpassel-cmyk.github.io/crowd-forecasts/)"


def load(name, default):
    try:
        with open(os.path.join(DATA, name), encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save(name, obj):
    path = os.path.join(DATA, name)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(path + ".tmp", path)


def day(s):
    return str(s or "")[:10]


def slug(s, n=48):
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")[:n]


def event_id(e):
    return f"{day(e.get('start'))}-{slug(e.get('title'))}"


def call_id(*parts):
    return hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()[:12]


# ---------- inputs ----------
def fetch_calendar():
    req = urllib.request.Request(CAL_URL, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r).get("events", [])


def upcoming(events, now, days=WINDOW_DAYS):
    """Events that are on now or start within `days`, soonest first."""
    today, until = now.strftime("%Y-%m-%d"), (now + timedelta(days=days)).strftime("%Y-%m-%d")
    out = []
    for e in events:
        start, end = day(e.get("start")), day(e.get("end") or e.get("start"))
        if not start or end < today or start > until:
            continue
        out.append(dict(e, id=event_id(e), start=start, end=end if end != start else None))
    out.sort(key=lambda e: (e["start"], e["title"]))
    return out[:MAX_EVENTS]


def markets(forecasts, now, days=MARKET_DAYS):
    """Open markets resolving soon enough to matter, by volume within each theme."""
    lo, hi = now.isoformat(), (now + timedelta(days=days)).isoformat()
    items = [i for i in forecasts.get("items", []) if i.get("resolves") and lo < i["resolves"] < hi and i.get("prob") is not None]
    by = {}
    for i in sorted(items, key=lambda i: -(i.get("volume") or 0)):
        by.setdefault((i.get("themes") or ["other"])[0], []).append(i)
    lanes, out = list(by.values()), []
    while len(out) < MAX_MARKETS and any(lanes):
        for lane in lanes:
            if lane and len(out) < MAX_MARKETS:
                out.append(lane.pop(0))
    return sorted(out, key=lambda i: i["resolves"])


def market_line(i):
    what = f"crowd {round(i['prob'] * 100)}%"
    if i.get("kind") == "multi":
        what += f" for '{i.get('lead')}'"
    elif i.get("kind") == "ladder":
        what += f" for 'by {i.get('lead')}'"
    tag = "B" if i.get("kind") == "binary" else "M"
    return f"{i['id']} [{tag}] | {i['title']} | {what} | resolves {day(i['resolves'])} | {i['source']}"


# ---------- settling ----------
def last_price(mid, forecasts, history):
    for i in forecasts.get("items", []):
        if i["id"] == mid:
            return i.get("prob")
    h = history.get(mid) or []
    return h[-1][1] if h else None


def settle_from_markets(calls, forecasts, history, now):
    """Settle market calls whose deadline passed and whose last price is clear."""
    today = now.strftime("%Y-%m-%d")
    n = 0
    for c in calls:
        if c["status"] != "open" or c["type"] != "market" or c["by"] >= today:
            continue
        p = last_price(c["market"], forecasts, history)
        if p is None:
            continue
        if p >= CLEAR or p <= 1 - CLEAR:
            c.update(status="yes" if p >= CLEAR else "no", settled=today, how="final market price")
            n += 1
    return n


def due_for_claude(calls, now):
    today = now.strftime("%Y-%m-%d")
    grace = (now - timedelta(days=2)).strftime("%Y-%m-%d")   # give markets two days to settle first
    return [c for c in calls if c["status"] == "open" and c["by"] < (today if c["type"] == "own" else grace)][:25]


def void_old(calls, now):
    limit = (now - timedelta(days=VOID_AFTER_DAYS)).strftime("%Y-%m-%d")
    for c in calls:
        if c["status"] == "open" and c["by"] < limit:
            c.update(status="void", settled=now.strftime("%Y-%m-%d"), how="no clear outcome after 30 days")


def brier(p, yes):
    return (p - (1.0 if yes else 0.0)) ** 2


def scoreboard(calls):
    done = [c for c in calls if c["status"] in ("yes", "no")]
    mk = [c for c in done if c["type"] == "market" and c.get("crowd") is not None]
    own = [c for c in done if c["type"] == "own"]
    avg = lambda xs: round(sum(xs) / len(xs), 3) if xs else None
    return {
        "resolved": len(done), "open": sum(1 for c in calls if c["status"] == "open"),
        "market": {"n": len(mk), "claude": avg([brier(c["p"], c["status"] == "yes") for c in mk]),
                   "crowd": avg([brier(c["crowd"], c["status"] == "yes") for c in mk]),
                   "claude_closer": sum(1 for c in mk if brier(c["p"], c["status"] == "yes") < brier(c["crowd"], c["status"] == "yes"))},
        "own": {"n": len(own), "claude": avg([brier(c["p"], c["status"] == "yes") for c in own]),
                "right": sum(1 for c in own if (c["p"] > 0.5) == (c["status"] == "yes") and c["p"] != 0.5)},
        "next_due": min((c["by"] for c in calls if c["status"] == "open"), default=None),
    }


# ---------- Claude ----------
SYSTEM = (
    "You write the weekly outlook for 'Wisdom of the Crows', a private briefing for a global health policy "
    "coordinator at the Dutch Ministry of Health who wants to know what is likely to happen at upcoming events. "
    "You see the coming six weeks of his world calendar and what prediction markets currently expect. "
    "Say plainly what you expect, as an analyst would: concrete, calibrated probabilities, never vague adjectives. "
    "50% means a coin flip; use 3% or 97% only when you are nearly sure. Agree with the crowd when it is right "
    "and disagree when you have a reason, and give that reason. Health, multilateral diplomacy (WHO, G20, UN, EU), "
    "elections and conflict matter most to him; ignore sport and celebrity. "
    "Use web search for the few events where this week's news matters most, at most {searches} searches; "
    "otherwise work from the calendar, the prices and what you know. Never invent facts, outcomes or quotes. "
    "Today is {today}."
)


def build_prompt(events, mk, due, now):
    ev = "\n".join(f"{e['id']} | {e['start']}{' to ' + e['end'] if e.get('end') else ''} | {e['title']} | {e.get('place', '')} | {e.get('cat', '')}"
                   for e in events)
    ms = "\n".join(market_line(i) for i in mk)
    st = "\n".join(f"{c['id']} | due {c['by']} | {c['q']}" for c in due) or "(none)"
    return (
        f"UPCOMING EVENTS (id | dates | title | place | category):\n{ev}\n\n"
        f"OPEN MARKETS ([B] = yes/no market; id | question | crowd | resolves | source):\n{ms}\n\n"
        f"EARLIER CALLS TO SETTLE (their date has passed):\n{st}\n\n"
        "Return JSON only, no prose before or after, in this shape:\n"
        '{"brief":"4-5 sentences: the coming weeks in one view, what to watch, and where you and the crowd differ",'
        '"events":[{"e":"<event id>","expect":"what you expect to happen and why, max 45 words",'
        '"calls":[{"q":"a yes/no statement that will be clearly true or false by the date","by":"YYYY-MM-DD","p":0.0}],'
        '"markets":["<market id that bears on this event>"],"watch":"what would change your view, max 16 words",'
        '"sources":["url of a search result you relied on"]}],'
        '"odds":[{"m":"<[B] market id>","p":0.0,"why":"max 20 words"}],'
        '"settled":[{"c":"<call id>","outcome":"yes|no|unclear","source":"url"}]}\n'
        "Rules: cover the 10 to 14 most consequential events, soonest first; give each 1 to 3 calls that resolve by the "
        "event's end or shortly after, on what will actually be decided or said. In odds, give your probability for 12 to 20 "
        "[B] markets most relevant to these events or to his interests, and include every [B] market where you differ from "
        "the crowd by 10 points or more; p is the probability that the market resolves Yes. Settle every earlier call: yes "
        "or no only when you know, otherwise unclear. Only cite URLs that appeared in your search results."
    )


def claude(system, user, max_searches, timeout=300):
    """Messages API with the web search tool; follows pause_turn. Returns (text, urls, searches)."""
    msgs = [{"role": "user", "content": user}]
    tools = [{"type": "web_search_20250305", "name": "web_search", "max_uses": max_searches}] if max_searches else []
    text, urls, searches = "", {}, 0
    for _ in range(4):
        body = {"model": MODEL, "max_tokens": 9000, "system": system, "messages": msgs}
        if tools:
            body["tools"] = tools
        res = post(body, timeout)
        for b in res.get("content", []):
            if b.get("type") == "server_tool_use":
                searches += 1
            elif b.get("type") == "web_search_tool_result" and isinstance(b.get("content"), list):
                for r in b["content"]:
                    if r.get("url"):
                        urls[r["url"]] = r.get("title") or r["url"]
            elif b.get("type") == "text":
                text += b.get("text", "")
                for c in b.get("citations") or []:
                    if c.get("url"):
                        urls[c["url"]] = c.get("title") or c["url"]
        if res.get("stop_reason") != "pause_turn":
            return text, urls, searches
        msgs = [msgs[0], {"role": "assistant", "content": res["content"]}]
    return text, urls, searches


def post(body, timeout):
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(), headers={
        "x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01", "content-type": "application/json"})
    last = ""
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read().decode("utf-8", "replace")).get("error", {}).get("message", "")
            except Exception:  # noqa: BLE001
                msg = ""
            last = f"HTTP {e.code}" + (f": {msg[:160].rstrip('.')}" if msg else "")
            if e.code in (400, 401, 403, 404):
                raise RuntimeError(f"Claude API refused the request ({last}). Check the ANTHROPIC_API_KEY secret and the account's credit.")
        except Exception as e:  # network or timeout
            last = type(e).__name__
        print(f"Claude call failed ({last}); attempt {attempt + 1}/3", file=sys.stderr)
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"Claude API unavailable ({last}); will retry tomorrow.")


def parse(text):
    """The outermost JSON object in Claude's reply, or None."""
    a, b = text.find("{"), text.rfind("}")
    if a < 0 or b <= a:
        return None
    try:
        return json.loads(text[a:b + 1])
    except json.JSONDecodeError:
        return None


def prob(x):
    try:
        p = float(x)
    except (TypeError, ValueError):
        return None
    if p > 1:          # 65 instead of 0.65
        p /= 100
    return round(min(0.99, max(0.01, p)), 3) if 0 <= p <= 1 else None


def apply(reply, events, mk, calls, urls, now):
    """Turn Claude's reply into the outlook file and new calls. Returns the outlook dict."""
    today = now.strftime("%Y-%m-%d")
    evs = {e["id"]: e for e in events}
    mks = {i["id"]: i for i in mk}
    have = {c["id"] for c in calls}
    out_events = []
    for x in reply.get("events") or []:
        e = evs.get(str(x.get("e")))
        if not e:
            continue
        cs = []
        for c in (x.get("calls") or [])[:3]:
            q, by, p = str(c.get("q") or "").strip(), day(c.get("by")), prob(c.get("p"))
            if not q or p is None or not re.match(r"\d{4}-\d\d-\d\d$", by) or by < today:
                continue
            cid = call_id("own", e["id"], q)
            cs.append({"id": cid, "q": q, "by": by, "p": p})
            if cid not in have:
                calls.append({"id": cid, "type": "own", "made": today, "by": by, "q": q, "p": p,
                              "event": e["title"], "status": "open"})
                have.add(cid)
        srcs = [{"url": u, "title": urls[u]} for u in (x.get("sources") or []) if isinstance(u, str) and u in urls][:3]
        out_events.append({**{k: e.get(k) for k in ("id", "title", "start", "end", "place", "cat", "src")},
                           "expect": str(x.get("expect") or "").strip()[:400], "calls": cs,
                           "markets": [m for m in (x.get("markets") or []) if m in mks][:4],
                           "watch": str(x.get("watch") or "").strip()[:160], "sources": srcs})
    odds = {}
    for o in reply.get("odds") or []:
        m, p = mks.get(str(o.get("m"))), prob(o.get("p"))
        if not m or p is None or m.get("kind") != "binary":
            continue
        odds[m["id"]] = {"p": p, "crowd": m["prob"], "why": str(o.get("why") or "").strip()[:200]}
        cid = call_id("market", m["id"], today)
        if cid not in have:
            calls.append({"id": cid, "type": "market", "made": today, "by": day(m["resolves"]), "q": m["title"],
                          "p": p, "crowd": m["prob"], "market": m["id"], "url": m["url"], "source": m["source"],
                          "status": "open"})
            have.add(cid)
    byid = {c["id"]: c for c in calls}
    for s in reply.get("settled") or []:
        c = byid.get(str(s.get("c")))
        outcome = str(s.get("outcome") or "").lower()
        if c and c["status"] == "open" and outcome in ("yes", "no"):
            src = s.get("source") if isinstance(s.get("source"), str) and s.get("source") in urls else None
            c.update(status=outcome, settled=today, how="Claude, with a source" if src else "Claude", source=src)
    listed = {e["id"] for e in out_events}
    return {"generated": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "model": MODEL,
            "brief": str(reply.get("brief") or "").strip()[:1200], "events": out_events, "odds": odds,
            "also": [{k: e.get(k) for k in ("id", "title", "start", "end", "place", "cat")} for e in events if e["id"] not in listed]}


def due(outlook, now, force=False):
    if force or not outlook.get("generated"):
        return True
    last = datetime.fromisoformat(outlook["generated"].replace("Z", "+00:00"))
    return now - last >= timedelta(days=EVERY_DAYS) - timedelta(hours=4)


def main():
    now = datetime.now(timezone.utc)
    forecasts = load("forecasts.json", {"items": []})
    history = load("history.json", {})
    calls = load("calls.json", {"calls": []})["calls"]
    outlook = load("outlook.json", {})
    status = outlook.get("status", {})
    status["settled_today"] = settle_from_markets(calls, forecasts, history, now)

    if not os.environ.get("ANTHROPIC_API_KEY"):
        status["note"] = "No ANTHROPIC_API_KEY secret: the outlook is not written."
    elif due(outlook, now, os.environ.get("FORCE_OUTLOOK") == "true"):
        try:
            events = upcoming(fetch_calendar(), now)
        except Exception as e:  # noqa: BLE001
            events = []
            print("calendar failed:", e, file=sys.stderr)
        mk = markets(forecasts, now)
        todo = due_for_claude(calls, now)
        try:
            if not events:
                raise RuntimeError("World calendar could not be read; the outlook waits for tomorrow.")
            text, urls, searches = claude(SYSTEM.format(searches=MAX_SEARCHES, today=now.strftime("%A %d %B %Y")),
                                          build_prompt(events, mk, todo, now), MAX_SEARCHES)
            reply = parse(text)
            if not reply:
                raise RuntimeError("Claude's reply was not valid JSON; the outlook waits for tomorrow.")
            new = apply(reply, events, mk, calls, urls, now)
            status = {"settled_today": status["settled_today"], "searches": searches, "events": len(new["events"]),
                      "odds": len(new["odds"])}
            outlook = new
        except RuntimeError as e:
            status["note"] = str(e)
            print(status["note"], file=sys.stderr)
    void_old(calls, now)
    status["last_run"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    outlook["status"] = status
    outlook["score"] = scoreboard(calls)
    outlook["resolved"] = sorted([c for c in calls if c["status"] in ("yes", "no")], key=lambda c: c["settled"], reverse=True)[:12]
    save("calls.json", {"calls": calls})
    save("outlook.json", outlook)
    print(json.dumps({k: outlook.get(k) for k in ("generated", "status", "score")}, indent=1))


if __name__ == "__main__":
    main()
