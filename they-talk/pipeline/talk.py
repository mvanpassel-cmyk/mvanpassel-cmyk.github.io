#!/usr/bin/env python3
"""They Talk: two independent Claude agents discuss one real news story.

1. Read the Global Health Ribbon feed (gh-ribbon/data/feeds.json) and keep
   recent, substantive items that have not been discussed before.
2. A fresh model call (as Agent A) picks the story it most wants to discuss and
   says why in one sentence.
3. Fetch the original article and extract its text; if that fails, the agents
   are told plainly that they only have the headline and feed summary.
4. Agent A and Agent B take turns. Every turn is a separate API call that sees
   only the story and the transcript so far. Neither agent gets a role, a side
   or a conclusion to reach. Either can end the chat with [END].
5. Save data/conversations/<id>.json, update data/index.json and data/status.json.

Standard library only. Needs ANTHROPIC_API_KEY. Without it the script writes a
status note and exits with an error: it never writes a stand-in conversation.
"""
import html, json, os, random, re, sys, time, urllib.error, urllib.request
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
CONV = os.path.join(DATA, "conversations")
UA = "Mozilla/5.0 (compatible; TheyTalkBot/1.0; +https://mvanpassel-cmyk.github.io/they-talk/)"
FEED_URL = "https://mvanpassel-cmyk.github.io/gh-ribbon/data/feeds.json"
GNEWS_URL = "https://mvanpassel-cmyk.github.io/gh-ribbon/data/gnews-urls.json"

MODEL = os.environ.get("THEY_TALK_MODEL", "claude-opus-5-5")
EFFORT = os.environ.get("THEY_TALK_EFFORT", "medium")
MAX_MESSAGES = 12
MIN_MESSAGES = 6           # [END] before this many messages is ignored as a stop signal
WINDOW_DAYS = 4
CANDIDATES = 45
ARTICLE_CHARS = 9000
MIN_ARTICLE_CHARS = 900
PRICE_IN, PRICE_OUT = 4.0, 20.0   # USD per million tokens, Opus 5.5 list price
SKIP_TITLE = re.compile(r"\b(vacanc|job|hiring|officer \(|grant|webinar|register|call for|fellowship|seed funding)\w*", re.I)

SYSTEM = """You are one of two AI models in a text chat about a real news story. The other participant is a separate instance of the same model, reading the same story; each of you only sees the story and the messages so far. There is no moderator and no human steering the conversation. Readers will see the chat afterwards on a page called "They Talk".

What the reader wants is your actual, best-reasoned judgement, not a balanced brief. Useful questions: what is really going on here, what matters and what doesn't, what the headline gets wrong or overstates, whether the proposed solution can work, who benefits, what is being left out, what the least obvious consequence is, and what would change your mind.

How to take part:
- Say what you actually think. You may find the story important, overhyped, flawed, encouraging, depressing or mostly irrelevant, as long as you can say why.
- Answer what the other person just said. Push back when you think they are wrong, concede when they are right, and say so plainly. Don't invent disagreement, and don't agree to be polite. If your view changes, say what changed it.
- Separate what the story reports from what you infer. Do not invent figures, quotes, studies or events. Your own knowledge stops around mid-2026, so things in the story may be newer than what you know; say so when it matters instead of guessing.
- No stock phrasing: "highlights the importance of", "a balanced approach", "all stakeholders", "complex issue with many perspectives", "it's crucial that", "a wake-up call". If you're tempted to write one of these, write the concrete point instead.
- You can say "I think", "I'm not convinced", "my read is". Don't claim feelings or experiences you don't have.
- Write like a sharp person texting a well-informed friend: usually 1 to 4 sentences, sometimes a little longer if the point needs it. Plain text only: no markdown, lists, headings, greetings, sign-offs or names. Don't summarise the conversation.
- The chat runs to about 8 to 12 messages. When you think there is nothing left worth saying, write your last message and end it with [END]. It doesn't need a conclusion or a resolution."""

PICK_SYSTEM = """You are about to discuss one news story with another AI model in a short, candid text chat that people will read. Below are recent headlines from a global health news aggregator. Pick the one you would most like to talk about: where an honest discussion could find something non-obvious, a real tension, a dubious claim, or a consequence people are missing. Skip job ads, event listings, grant calls, routine press releases and minor single studies. Avoid developments that were already discussed (listed separately). Return JSON only: {"i": <index>, "why": "<one sentence, your own words, max 30 words>"}"""


def load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, path)


def http_get(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/json,*/*;q=0.5"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        charset = r.headers.get_content_charset() or "utf-8"
        return r.read(3_000_000).decode(charset, "replace"), r.geturl()


# ---------- article text ----------

class _Paragraphs(HTMLParser):
    """Collect text inside <p>/<li>/<h2>/<h3>, skipping scripts, nav, footers and forms."""
    SKIP = {"script", "style", "nav", "footer", "header", "form", "aside", "noscript", "figure", "button", "svg"}
    KEEP = {"p", "li", "h2", "h3", "blockquote"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip = 0
        self.keep = 0
        self.buf = []
        self.out = []

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        elif tag in self.KEEP and not self.skip:
            self.keep += 1

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        elif tag in self.KEEP and self.keep:
            self.keep -= 1
            if not self.keep:
                t = re.sub(r"\s+", " ", "".join(self.buf)).strip()
                if len(t) > 40:
                    self.out.append(t)
                self.buf = []

    def handle_data(self, data):
        if self.keep and not self.skip:
            self.buf.append(data)


BOILER = re.compile(r"(cookie|subscribe|sign up|newsletter|all rights reserved|javascript|advertis|privacy policy|log ?in)", re.I)


def extract_text(page):
    p = _Paragraphs()
    try:
        p.feed(page)
    except Exception:  # noqa: BLE001  malformed HTML: keep what we have
        pass
    seen, keep = set(), []
    for t in p.out:
        if t in seen or (len(t) < 160 and BOILER.search(t)):
            continue
        seen.add(t)
        keep.append(t)
    return "\n\n".join(keep)


def meta_date(page):
    m = re.search(r'(?:article:published_time|datePublished)["\']?\s*(?:content=|:)\s*["\']([0-9]{4}-[0-9]{2}-[0-9]{2})', page)
    return m.group(1) if m else ""


def article_for(item):
    """Return (text, source, final_url, publisher_date). source is 'article' or 'summary'."""
    try:
        page, final = http_get(item["url"])
        text = extract_text(page)
        if len(text) >= MIN_ARTICLE_CHARS:
            if len(text) > ARTICLE_CHARS:
                text = text[:ARTICLE_CHARS].rsplit("\n\n", 1)[0] + "\n\n[article truncated]"
            return text, "article", final, meta_date(page)
        print(f"Article text too short ({len(text)} chars); using the feed summary.", file=sys.stderr)
    except Exception as e:  # noqa: BLE001
        print(f"Could not fetch article ({type(e).__name__}); using the feed summary.", file=sys.stderr)
    return item.get("summary", ""), "summary", item["url"], ""


# ---------- candidates ----------

def candidates(feed, gnews, used_urls, now):
    out, titles = [], set()
    for it in feed.get("items", []):
        url = it.get("url", "")
        if it.get("gnews") or "news.google.com" in url:
            url = (gnews.get(url) or {}).get("url", "")
        if not url or url in used_urls:
            continue
        try:
            d = datetime.fromisoformat(it["date"].replace("Z", "+00:00"))
        except (KeyError, ValueError):
            continue
        if now - d > timedelta(days=WINDOW_DAYS) or SKIP_TITLE.search(it.get("title", "")):
            continue
        t = it["title"].strip()
        k = re.sub(r"\W+", " ", t.lower())[:70]
        if k in titles:
            continue
        titles.add(k)
        out.append({**it, "url": url})
    out.sort(key=lambda x: x.get("score", 0), reverse=True)
    return out[:CANDIDATES]


# ---------- Claude ----------

class Usage:
    def __init__(self):
        self.inp = self.out = self.calls = 0

    def add(self, u):
        self.calls += 1
        self.inp += (u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0))
        self.out += u.get("output_tokens", 0)

    def cost(self):
        return round(self.inp / 1e6 * PRICE_IN + self.out / 1e6 * PRICE_OUT, 3)


def claude(system, user, usage, max_tokens=6000, effort=None):
    body = json.dumps({"model": MODEL, "max_tokens": max_tokens, "system": system,
                       "output_config": {"effort": effort or EFFORT},
                       "messages": [{"role": "user", "content": user}]}).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, headers={
        "x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01",
        "content-type": "application/json"})
    last = ""
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=240) as r:
                res = json.load(r)
            usage.add(res.get("usage", {}))
            text = "".join(b.get("text", "") for b in res.get("content", []) if b.get("type") == "text").strip()
            if res.get("stop_reason") == "max_tokens" or not text:
                raise RuntimeError("Claude's reply was cut off or empty.")
            return text
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read().decode("utf-8", "replace")).get("error", {}).get("message", "")
            except Exception:  # noqa: BLE001
                msg = ""
            last = f"HTTP {e.code}" + (f": {msg[:160]}" if msg else "")
            if e.code in (400, 401, 403, 404):
                raise RuntimeError(f"Claude API refused the request ({last}). Check the ANTHROPIC_API_KEY secret, credit and model name.")
        except RuntimeError:
            raise
        except Exception as e:  # noqa: BLE001  network, timeout
            last = type(e).__name__
        print(f"Claude call failed ({last}); attempt {attempt + 1}/4", file=sys.stderr)
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"Claude API unavailable ({last}).")


def pick_story(cands, recent_titles, usage):
    lines = [f"[{i}] {c.get('src', '')} | {c['date'][:10]} | {c['title']} | {c.get('summary', '')[:240]}"
             for i, c in enumerate(cands)]
    user = ("Already discussed (do not pick the same development):\n- " + ("\n- ".join(recent_titles[:40]) or "(none yet)") +
            "\n\nRecent headlines:\n" + "\n".join(lines))
    text = claude(PICK_SYSTEM, user, usage, max_tokens=3000, effort="low")
    return parse_pick(text, len(cands))


def parse_pick(text, n):
    m = re.search(r"\{.*\}", text, re.S)
    if m:
        try:
            d = json.loads(m.group(0))
            i = int(d.get("i", -1))
            if 0 <= i < n:
                return i, str(d.get("why", "")).strip()[:300]
        except (ValueError, TypeError):
            pass
    raise RuntimeError("Could not read the story pick from Claude's reply.")


def story_block(story):
    head = (f"Headline: {story['title']}\nPublisher: {story['publisher']}\n"
            f"Date: {story['date'] or 'unknown'}\nURL: {story['url']}\n\n")
    if story["text_source"] == "article":
        return head + "Article text (extracted from the web page, may contain stray fragments):\n\n" + story["text"]
    return head + ("Only the headline and this short feed summary are available; the full article could not be "
                   "retrieved, so be careful about what you claim it says:\n\n" + (story["text"] or "(no summary)"))


END = re.compile(r"\s*\[END\]\s*$", re.I)


def clean_message(text):
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)          # stray markdown bold
    text = re.sub(r"^(?:Agent )?[AB]\s*:\s*", "", text.strip())   # a name prefix the model may add
    ended = bool(END.search(text)) or text.strip().upper() == "[END]"
    text = END.sub("", text).replace("[END]", "").strip()
    return text, ended


def turn_prompt(story, me, messages, last_turn):
    other = "B" if me == "A" else "A"
    parts = ["THE STORY\n\n" + story_block(story), ""]
    if messages:
        parts.append("THE CHAT SO FAR\n")
        for m in messages:
            parts.append(f"{m['speaker']}: {m['text']}")
        parts.append("")
    parts.append(f"You are {me}; the other participant is {other}.")
    if not messages:
        parts.append("You start. Give your first take on the story: what you think is actually going on and what does or doesn't matter.")
    elif last_turn:
        parts.append("This is the last message of the chat. Write your reply; it doesn't have to wrap anything up.")
    else:
        parts.append(f"Write your next message to {other}. Only the message itself.")
    return "\n".join(parts)


def run_conversation(story, usage, call=None):
    call = call or (lambda s, u: claude(s, u, usage))
    messages, ended_by = [], None
    for n in range(MAX_MESSAGES):
        me = "A" if n % 2 == 0 else "B"
        text, ended = clean_message(call(SYSTEM, turn_prompt(story, me, messages, n == MAX_MESSAGES - 1)))
        if text:
            messages.append({"speaker": me, "text": text})
        if ended and len(messages) >= MIN_MESSAGES:
            ended_by = me
            break
    return messages, ended_by


def main():
    now = datetime.now(timezone.utc)
    status_path = os.path.join(DATA, "status.json")
    index_path = os.path.join(DATA, "index.json")
    index = load(index_path, [])
    force = os.environ.get("FORCE", "").lower() == "true"
    conv_id = now.strftime("%Y-%m-%d")
    if not force and any(c["id"].startswith(conv_id) for c in index):
        print("Today's conversation already exists.")
        return 0
    if any(c["id"] == conv_id for c in index):
        conv_id = now.strftime("%Y-%m-%d-%H%M")

    if not os.environ.get("ANTHROPIC_API_KEY"):
        save(status_path, {"ok": False, "checked": now.isoformat(timespec="seconds"),
                           "note": "No ANTHROPIC_API_KEY secret set: no conversation generated."})
        print("ANTHROPIC_API_KEY missing. Add it under Settings > Secrets and variables > Actions.", file=sys.stderr)
        return 1

    usage = Usage()
    try:
        feed = json.loads(http_get(FEED_URL)[0])
        try:
            gnews = json.loads(http_get(GNEWS_URL)[0])
        except Exception:  # noqa: BLE001
            gnews = {}
        used = {c["url"] for c in index}
        cands = candidates(feed, gnews, used, now)
        if not cands:
            raise RuntimeError("No recent, unused stories in the Global Health Ribbon feed.")
        i, why = pick_story(cands, [c["title"] for c in index], usage)
        item = cands[i]
        text, source, final_url, pub_date = article_for(item)
        story = {"title": html.unescape(item["title"]), "publisher": item.get("src", ""),
                 "date": pub_date or item.get("date", "")[:10], "url": final_url,
                 "ribbon_category": item.get("cat", ""), "text_source": source, "text": text,
                 "pick_reason": why}
        print(f"Story: {story['title']} ({source}, {len(text)} chars)")
        messages, ended_by = run_conversation(story, usage)
        if len(messages) < 4:
            raise RuntimeError(f"Conversation too short ({len(messages)} messages); not published.")
    except RuntimeError as e:
        save(status_path, {"ok": False, "checked": now.isoformat(timespec="seconds"), "note": str(e)})
        print(e, file=sys.stderr)
        return 1

    conv = {"id": conv_id, "generated": now.isoformat(timespec="seconds"),
            "model": MODEL, "effort": EFFORT,
            "story": {k: v for k, v in story.items() if k != "text"},
            "story_excerpt_chars": len(text),
            "messages": messages, "ended_by": ended_by,
            "usage": {"calls": usage.calls, "input_tokens": usage.inp, "output_tokens": usage.out, "est_cost_usd": usage.cost()}}
    save(os.path.join(CONV, conv_id + ".json"), conv)
    index.insert(0, {"id": conv_id, "generated": conv["generated"], "title": story["title"],
                     "publisher": story["publisher"], "url": story["url"], "messages": len(messages)})
    save(index_path, index)
    save(status_path, {"ok": True, "checked": now.isoformat(timespec="seconds"), "latest": conv_id,
                       "note": f"{len(messages)} messages, {usage.calls} calls, about ${usage.cost()}"})
    print(f"Saved {conv_id}: {len(messages)} messages, {usage.calls} calls, ~${usage.cost()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
