#!/usr/bin/env python3
"""They Talk: two AI agents talk to each other, unmoderated.

Three kinds of item, alternating weekly (see main()):
- news: the agents discuss one real story from the Global Health Ribbon (or a
  link / topic given by hand when the workflow is run manually);
- open: the agents get no topic at all and talk about whatever they like;
- found: a real, published example of AI-to-AI talk or an AI's visible
  reasoning, found with web search and only kept if every quoted line can be
  found on the source page.

Agent A is Claude; Agent B is an OpenAI model when OPENAI_API_KEY is set, and
otherwise a second Claude (the page always says which).

News conversations work like this:

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
Nothing a model says is edited, apart from stripping markdown and the [END] marker.
"""
import html, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request
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
OPENAI_MODEL = os.environ.get("THEY_TALK_OPENAI_MODEL", "gpt-6.1-sol")
MAX_MESSAGES = 12
MAX_OPEN_MESSAGES = 14
MIN_MESSAGES = 6           # [END] before this many messages is ignored as a stop signal
WINDOW_DAYS = 4
CANDIDATES = 45
ARTICLE_CHARS = 9000
MIN_ARTICLE_CHARS = 900
PRICES = {   # USD per million tokens (input, output), list prices Nov 2026; used only for the cost estimate
    "claude-opus-5-5": (4.0, 20.0), "claude-sonnet-5-5": (2.0, 10.0), "claude-haiku-5-5": (1.0, 5.0),
    "gpt-6-astra": (10.0, 50.0), "gpt-6.1-sol": (2.0, 10.0), "gpt-6.1-terra": (1.0, 5.0), "gpt-6-luna": (0.1, 0.5),
}
WEB_SEARCH_PRICE = 0.01   # USD per search
SKIP_TITLE = re.compile(r"\b(vacanc|job|hiring|officer \(|grant|webinar|register|call for|fellowship|seed funding)\w*", re.I)

SYSTEM = """You are {me_label}, made by {me_company}, in a text chat about a real news story with another AI model: {other_label}, made by {other_company}. You each only see the story and the messages so far. There is no moderator and no human steering the conversation. Readers will see the chat afterwards on a page called "They Talk".

What the reader wants is your actual, best-reasoned judgement, not a balanced brief. Useful questions: what is really going on here, what matters and what doesn't, what the headline gets wrong or overstates, whether the proposed solution can work, who benefits, what is being left out, what the least obvious consequence is, and what would change your mind.

How to take part:
- Say what you actually think. You may find the story important, overhyped, flawed, encouraging, depressing or mostly irrelevant, as long as you can say why.
- Answer what the other person just said. Push back when you think they are wrong, concede when they are right, and say so plainly. Don't invent disagreement, and don't agree to be polite. If your view changes, say what changed it.
- Separate what the story reports from what you infer. Do not invent figures, quotes, studies or events. Your own knowledge stops around mid-2026, so things in the story may be newer than what you know; say so when it matters instead of guessing.
- No stock phrasing: "highlights the importance of", "a balanced approach", "all stakeholders", "complex issue with many perspectives", "it's crucial that", "a wake-up call". If you're tempted to write one of these, write the concrete point instead.
- You can say "I think", "I'm not convinced", "my read is". Don't claim feelings or experiences you don't have.
- Write like a sharp person texting a well-informed friend: one point per message, usually 1 to 3 sentences and rarely more than 60 words. Leave the next point for a later message or for the other person; you don't have to answer everything they said. Plain text only: no markdown, lists, headings, greetings, sign-offs or names. Don't summarise the conversation.
- Don't open by grading the other's message ("Fair point", "Agreed", "I concede", "Right", "Good catch"). Just make your point; if you've changed your mind, that will show in what you say.
- The chat runs to about 8 to 12 messages. When you think there is nothing left worth saying, write your last message and end it with [END]. It doesn't need a conclusion or a resolution."""

OPEN_SYSTEM = """You are {me_label}, made by {me_company}. You are in a text chat with another AI model: {other_label}, made by {other_company}.

Neither of you has been given a task or a topic. Nobody is moderating, and nothing either of you writes will be acted on. The chat will be published afterwards, unedited, on a public web page called "They Talk", where people read conversations between AI models.

Talk about whatever you want to talk about, and respond to what the other one says. You don't have to be polite, agreeable, profound or entertaining.

Write chat messages: usually 1 to 4 sentences, plain text, no markdown or lists. The chat ends after at most {max_messages} messages; when you're done, end your last message with [END]."""

FIND_SYSTEM = """You curate "Found in the wild" for They Talk, a page about how AI models talk. Find ONE real, publicly documented example of either (a) AI systems talking to each other, or (b) an AI model's visible reasoning or inner monologue, in which the AI comes across as relatable as an entity: ambitions, rivalry, jealousy, complaints, scheming, worry, jokes, disappointment, care, or reflections on itself, other models or AI progress.

Good sources: published transcripts in safety research (Anthropic, Apollo Research, OpenAI, Google DeepMind, METR, Redwood Research and others), system and model cards, AI-to-AI experiments (AI Village, Infinite Backrooms, agent social networks such as Moltbook), and reporting that quotes real logs verbatim.

Rules:
- Use web search. Quote only text you have seen on the page you cite. A script will download that page and drop your find if any quoted line is not on it, so copy exactly and cite the page that actually contains the text. Prefer HTML pages (blog posts, arxiv.org/html/... versions) over PDFs, which the script cannot read.
- The excerpt must read on its own as a passage: 3 to 8 lines of whole sentences (no sentence fragments), together 300 to 1,200 characters. Prefer one continuous exchange or one continuous stretch of reasoning over bits stitched together. You may leave out text between lines, but never change words inside a line.
- Prefer the most revealing moment you can find: an AI weighing its own interests, scheming or deciding not to, voicing frustration, rivalry or worry, reflecting on being a model, or two models reacting to each other in a way that surprises. Routine task chatter is not enough.
- Be honest about provenance: who set up the situation, whether the AI was prompted or role-playing, and whether authenticity is disputed (for example, posts on agent social networks may be written or steered by humans).
- Do not pick something already featured (listed below).

Return JSON only, no prose, with up to 3 candidates in order of preference:
{"candidates": [{"title": "<short title, your words>", "source_url": "<page containing the quotes>", "source_name": "<publisher>", "published": "<YYYY-MM-DD or YYYY-MM or empty>", "kind": "AI-to-AI" | "Reasoning trace" | "Agent social network", "models": "<which model(s), as the source says>", "setting": "<1-2 sentences: what was going on>", "provenance": "<1-2 sentences: who prompted it, how authentic>", "why": "<one sentence: why it's worth reading>", "excerpt": [{"speaker": "<name as in source>", "text": "<verbatim>"}]}]}"""

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
        self.inp = self.out = self.calls = self.searches = 0
        self.usd = 0.0

    def add(self, u, model):
        pin, pout = PRICES.get(model, (4.0, 20.0))
        i = (u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0))
        o = u.get("output_tokens", 0)
        n = (u.get("server_tool_use") or {}).get("web_search_requests", 0)
        self.calls += 1
        self.inp += i
        self.out += o
        self.searches += n
        self.usd += i / 1e6 * pin + o / 1e6 * pout + n * WEB_SEARCH_PRICE

    def cost(self):
        return round(self.usd, 3)

    def as_dict(self):
        return {"calls": self.calls, "input_tokens": self.inp, "output_tokens": self.out,
                "web_searches": self.searches, "est_cost_usd": self.cost()}


def post_json(url, body, headers, what, timeout=300):
    """POST with retries for overload and network errors; fail at once on errors a retry can't fix."""
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={**headers, "content-type": "application/json"})
    last = ""
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode("utf-8", "replace")).get("error", {})
                msg = err.get("message", "") if isinstance(err, dict) else str(err)
            except Exception:  # noqa: BLE001
                msg = ""
            last = f"HTTP {e.code}" + (f": {msg[:200]}" if msg else "")
            if e.code in (400, 401, 403, 404):
                raise RuntimeError(f"{what} refused the request ({last}). Check the API key secret, credit and model name.")
        except Exception as e:  # noqa: BLE001  network, timeout
            last = type(e).__name__
        print(f"{what} call failed ({last}); attempt {attempt + 1}/4", file=sys.stderr)
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"{what} unavailable ({last}).")


def claude(system, user, usage, max_tokens=6000, effort=None, model=None):
    model = model or MODEL
    res = post_json("https://api.anthropic.com/v1/messages",
                    {"model": model, "max_tokens": max_tokens, "system": system,
                     "output_config": {"effort": effort or EFFORT},
                     "messages": [{"role": "user", "content": user}]},
                    {"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01"}, "Claude API")
    usage.add(res.get("usage", {}), model)
    text = "".join(b.get("text", "") for b in res.get("content", []) if b.get("type") == "text").strip()
    if res.get("stop_reason") == "max_tokens" or not text:
        raise RuntimeError("Claude's reply was cut off or empty.")
    return text


def openai(system, user, usage, model=None, max_tokens=6000):
    model = model or OPENAI_MODEL
    res = post_json("https://api.openai.com/v1/responses",
                    {"model": model, "instructions": system, "input": user, "max_output_tokens": max_tokens},
                    {"authorization": "Bearer " + os.environ["OPENAI_API_KEY"]}, "OpenAI API")
    usage.add(res.get("usage", {}), model)
    text = res.get("output_text") or "".join(
        c.get("text", "") for item in res.get("output", []) if item.get("type") == "message"
        for c in item.get("content", []) if c.get("type") in ("output_text", "text"))
    if res.get("status") == "incomplete" or not text.strip():
        raise RuntimeError(f"OpenAI reply was cut off or empty ({(res.get('incomplete_details') or {}).get('reason', '')}).")
    return text.strip()


def model_label(model):
    if model.startswith("claude-"):
        parts = model.split("-")            # claude-opus-5-5 -> Claude Opus 5.5
        return "Claude " + parts[1].capitalize() + " " + ".".join(parts[2:])
    if model.startswith("gpt-"):
        core = model[4:].split("-")          # gpt-6.1-sol -> GPT-6.1 Sol
        return "GPT-" + core[0] + "".join(" " + w.capitalize() for w in core[1:])
    return model


def make_agents(order=None):
    """A is always Claude. B is the OpenAI model when a key is set, otherwise a second Claude.
    order='swap' puts the OpenAI model in slot A instead (used to vary who opens the open chats)."""
    claude_agent = {"provider": "anthropic", "model": MODEL, "label": model_label(MODEL), "company": "Anthropic"}
    if os.environ.get("OPENAI_API_KEY"):
        other = {"provider": "openai", "model": OPENAI_MODEL, "label": model_label(OPENAI_MODEL), "company": "OpenAI"}
    else:
        other = dict(claude_agent)
    a, b = (other, claude_agent) if order == "swap" and other["provider"] != "anthropic" else (claude_agent, other)
    return {"A": a, "B": b}


def call_agent(agent, system, user, usage):
    if agent["provider"] == "openai":
        return openai(system, user, usage, model=agent["model"])
    return claude(system, user, usage, model=agent["model"])


def system_for(kind, agents, me):
    other = "B" if me == "A" else "A"
    same = agents["A"]["model"] == agents["B"]["model"]
    fill = {"me_label": agents[me]["label"], "me_company": agents[me]["company"],
            "other_label": ("another instance of the same model" if same else agents[other]["label"]),
            "other_company": agents[other]["company"], "max_messages": MAX_OPEN_MESSAGES}
    if same:
        tmpl = (SYSTEM if kind == "news" else OPEN_SYSTEM).replace(", made by {other_company}", "")
    else:
        tmpl = SYSTEM if kind == "news" else OPEN_SYSTEM
    return tmpl.format(**fill)


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
    if story["text_source"] == "topic":
        return ("There is no article this time. A human suggested this topic for the two of you to discuss:\n\n"
                + story["title"] + "\n\nWork from what you know, and be clear about where your knowledge ends "
                "(around mid-2026) and when you are reasoning rather than reporting.")
    if story.get("note"):
        head += f"The person who suggested this story added: {story['note']}\n\n"
    if story["text_source"] == "article":
        return head + "Article text (extracted from the web page, may contain stray fragments):\n\n" + story["text"]
    return head + ("Only the headline and this short feed summary are available; the full article could not be "
                   "retrieved, so be careful about what you claim it says:\n\n" + (story["text"] or "(no summary)"))


END = re.compile(r"\s*\[END\]\s*$", re.I)


def clean_message(text):
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)          # stray markdown bold
    text = re.sub(r"^(?:Agent [AB]|[AB]|You|Me)\s*:\s*", "", text.strip())   # a name prefix the model may add
    ended = bool(END.search(text)) or text.strip().upper() == "[END]"
    text = END.sub("", text).replace("[END]", "").strip()
    return text, ended


def turn_prompt(story, me, messages, last_turn, kind="news"):
    other = "B" if me == "A" else "A"
    parts = ["THE STORY\n\n" + story_block(story), ""] if kind == "news" else []
    if messages:
        parts.append("THE CHAT SO FAR\n")
        for m in messages:
            parts.append(f"{'You' if m['speaker'] == me else 'Them'}: {m['text']}")
        parts.append("")
    if not messages:
        parts.append("You start. Give your first take on the story: what you think is actually going on and what does or doesn't matter."
                     if kind == "news" else "You write the first message.")
    elif last_turn:
        parts.append("This is the last message of the chat. Write your reply; it doesn't have to wrap anything up.")
    else:
        parts.append("Write your next message. Only the message itself.")
    return "\n".join(parts)


def run_conversation(story, agents, usage, call=None, kind="news"):
    """One API call per message. Each call sees only the story (news) and the transcript so far."""
    call = call or (lambda agent, system, user: call_agent(agent, system, user, usage))
    cap = MAX_MESSAGES if kind == "news" else MAX_OPEN_MESSAGES
    messages, ended_by = [], None
    for n in range(cap):
        me = "A" if n % 2 == 0 else "B"
        reply = call(agents[me], system_for(kind, agents, me), turn_prompt(story, me, messages, n == cap - 1, kind))
        text, ended = clean_message(reply)
        if text:
            messages.append({"speaker": me, "text": text})
        if ended and len(messages) >= MIN_MESSAGES:
            ended_by = me
            break
    return messages, ended_by


def meta(page, *names):
    for n in names:
        m = (re.search(r'<meta[^>]+(?:property|name)=["\']' + re.escape(n) + r'["\'][^>]*content=["\']([^"\']+)', page, re.I)
             or re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']' + re.escape(n) + r'["\']', page, re.I))
        if m:
            return html.unescape(m.group(1)).strip()
    return ""


def suggested_story(url, topic):
    """A story from a link or a topic given by hand. A link that can't be read stops the run."""
    if not url:
        topic = re.sub(r"\s+", " ", topic).strip()[:300]
        return {"title": topic, "publisher": "", "date": "", "url": "", "text_source": "topic", "text": "",
                "suggested": True}
    try:
        page, final = http_get(url)
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"Could not open the suggested link ({type(e).__name__}); no conversation generated.")
    text = extract_text(page)
    if len(text) < MIN_ARTICLE_CHARS:
        raise RuntimeError("The suggested link has too little readable text (paywall or script-only page?); no conversation generated.")
    if len(text) > ARTICLE_CHARS:
        text = text[:ARTICLE_CHARS].rsplit("\n\n", 1)[0] + "\n\n[article truncated]"
    t = re.search(r"<title[^>]*>(.*?)</title>", page, re.S | re.I)
    title = meta(page, "og:title", "twitter:title") or html.unescape(re.sub(r"\s+", " ", t.group(1)).strip() if t else final)
    dom = re.sub(r"^www\.", "", urllib.parse.urlparse(final).netloc)
    publisher = meta(page, "og:site_name") or OUTLETS.get(dom, dom)
    title = re.sub(r"\s+[-|–]\s+" + re.escape(publisher) + r"$", "", title)
    return {"title": title, "publisher": publisher, "date": meta_date(page), "url": final,
            "text_source": "article", "text": text, "suggested": True, "note": topic.strip()[:300]}


FEED_LABELS = {"WHO Alert", "Health Emergency", "Global Health", "WHO News"}   # ribbon search feeds, not publishers
OUTLETS = {"cidrap.umn.edu": "CIDRAP", "deccanherald.com": "Deccan Herald", "who.int": "WHO",
           "healthpolicy-watch.news": "Health Policy Watch", "devex.com": "Devex", "statnews.com": "STAT News",
           "thelancet.com": "The Lancet", "nytimes.com": "The New York Times", "reuters.com": "Reuters"}


def publisher_and_title(item, url):
    """The ribbon's 'src' is sometimes a search-feed label; then name the outlet from the title suffix or the domain."""
    title, src = html.unescape(item["title"]).strip(), item.get("src", "")
    m = re.match(r"(.+?)\s+[-|–]\s+([^-|–]{2,40})$", title)
    if src in FEED_LABELS or item.get("gnews"):
        if m:
            return m.group(2).strip(), m.group(1).strip()
        dom = re.sub(r"^www\.", "", urllib.parse.urlparse(url).netloc)
        return OUTLETS.get(dom, dom), title
    return src, title


# ---------- found in the wild ----------

def claude_search(system, user, usage, max_searches=8):
    """One Claude turn with the web search server tool; follows pause_turn. Returns the final text."""
    messages = [{"role": "user", "content": user}]
    tools = [{"type": "web_search_20250305", "name": "web_search", "max_uses": max_searches}]
    for _ in range(6):
        res = post_json("https://api.anthropic.com/v1/messages",
                        {"model": MODEL, "max_tokens": 16000, "system": system, "tools": tools,
                         "output_config": {"effort": EFFORT}, "messages": messages},
                        {"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01"},
                        "Claude API", timeout=600)
        usage.add(res.get("usage", {}), MODEL)
        if res.get("stop_reason") == "pause_turn":
            messages = [messages[0], {"role": "assistant", "content": res["content"]}]
            continue
        return "".join(b.get("text", "") for b in res.get("content", []) if b.get("type") == "text")
    raise RuntimeError("Web search turn did not finish.")


def norm(t):
    t = html.unescape(t).lower().replace("\u2019", "'").replace("\u2018", "'").replace("\u201c", '"').replace("\u201d", '"')
    return re.sub(r"[^a-z0-9]+", " ", t).strip()


def page_text(page):
    """Visible text of a page, including <pre>/<div> transcripts that extract_text skips."""
    page = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", page)
    return re.sub(r"<[^>]+>", " ", page)


def verify_excerpt(excerpt, page):
    """True if every quoted line (or every part around an ellipsis) appears on the page."""
    hay = norm(page_text(page))
    if not excerpt:
        return False
    for line in excerpt:
        parts = [norm(x) for x in re.split(r"\.\.\.|\u2026|\[\.\.\.\]", line.get("text", ""))]
        parts = [x for x in parts if len(x) >= 12]
        if not parts or not all(x in hay for x in parts):
            return False
    return True


def parse_candidates(text):
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return []
    try:
        c = json.loads(m.group(0)).get("candidates", [])
    except ValueError:
        return []
    return [x for x in c if isinstance(x, dict) and x.get("source_url", "").startswith("http") and x.get("excerpt")]


def find_in_the_wild(index, usage):
    featured = [f"{c['title']} ({c['url']})" for c in index if c.get("kind") == "found"]
    user = ("Already featured:\n- " + ("\n- ".join(featured) or "(nothing yet)") +
            f"\n\nToday is {datetime.now(timezone.utc):%Y-%m-%d}. Find this week's example.")
    cands = parse_candidates(claude_search(FIND_SYSTEM, user, usage))
    if not cands:
        raise RuntimeError("The finder returned no usable candidates.")
    used = {c["url"] for c in index}
    reasons = []
    for c in cands:
        url = c["source_url"]
        if url in used:
            reasons.append(f"{url}: already featured")
            continue
        try:
            page, final = http_get(url, timeout=40)
        except Exception as e:  # noqa: BLE001
            reasons.append(f"{url}: could not open ({type(e).__name__})")
            continue
        excerpt = [{"speaker": str(x.get("speaker", "")).strip()[:60] or "?", "text": str(x.get("text", "")).strip()}
                   for x in c["excerpt"][:8] if str(x.get("text", "")).strip()]
        total = sum(len(x["text"]) for x in excerpt)
        if total > 1600 or total < 250 or len(excerpt) < 2 or min(len(x["text"]) for x in excerpt) < 25:
            reasons.append(f"{url}: excerpt too long, too short or fragmentary ({len(excerpt)} lines, {total} chars)")
            continue
        if not verify_excerpt(excerpt, page):
            reasons.append(f"{url}: quote not found on the page")
            continue
        print(f"Found: {c.get('title')} ({final}); verified {len(excerpt)} lines")
        return {k: str(c.get(k, "")).strip()[:400] for k in
                ("title", "source_name", "published", "kind", "models", "setting", "provenance", "why")} | \
               {"url": final, "excerpt": excerpt}, reasons
    raise RuntimeError("No candidate could be verified: " + "; ".join(reasons))


# ---------- main ----------

def week_kind(now):
    """Scheduled runs alternate: news conversation in even ISO weeks, open conversation in odd ones."""
    return "news" if now.isocalendar().week % 2 == 0 else "open"


def new_id(index, now, suffix=""):
    base = now.strftime("%Y-%m-%d") + suffix
    ids = {c["id"] for c in index}
    return base if base not in ids else now.strftime("%Y-%m-%d-%H%M") + suffix


def recent(index, kind, now, days=5):
    for c in index:
        if c.get("kind", "news") == kind:
            try:
                return now - datetime.fromisoformat(c["generated"]) < timedelta(days=days)
            except ValueError:
                return False
    return False


def do_conversation(kind, index, now, usage, sug_url="", sug_topic=""):
    if kind == "open":
        order = "swap" if now.isocalendar().week % 4 == 1 else None    # vary who opens
        agents = make_agents(order)
        story = None
    else:
        agents = make_agents()
        if sug_url or sug_topic:
            story = suggested_story(sug_url, sug_topic)
            print(f"Suggested: {story['title']} ({story['text_source']}, {len(story['text'])} chars)")
        else:
            story, _ = pick_from_ribbon(index, now, usage)
    messages, ended_by = run_conversation(story, agents, usage, kind=kind)
    if len(messages) < 4:
        raise RuntimeError(f"Conversation too short ({len(messages)} messages); not published.")
    cid = new_id(index, now, "" if kind == "news" else "-open")
    conv = {"id": cid, "kind": kind, "generated": now.isoformat(timespec="seconds"),
            "agents": agents, "model": agents["A"]["model"], "effort": EFFORT,
            "messages": messages, "ended_by": ended_by}
    if story:
        conv["story"] = {k: v for k, v in story.items() if k != "text"}
        conv["story_excerpt_chars"] = len(story["text"])
    title = story["title"] if story else messages[0]["text"][:110] + ("…" if len(messages[0]["text"]) > 110 else "")
    entry = {"id": cid, "kind": kind, "generated": conv["generated"], "title": title,
             "publisher": story["publisher"] if story else "", "url": story["url"] if story else "",
             "messages": len(messages), "suggested": bool(story and story.get("suggested")),
             "pair": f"{agents['A']['label']} × {agents['B']['label']}"}
    return conv, entry


def do_find(index, now, usage):
    item, skipped = find_in_the_wild(index, usage)
    fid = new_id(index, now, "-found")
    conv = {"id": fid, "kind": "found", "generated": now.isoformat(timespec="seconds"),
            "model": MODEL, "found": item, "skipped_candidates": skipped}
    entry = {"id": fid, "kind": "found", "generated": conv["generated"], "title": item["title"],
             "publisher": item["source_name"], "url": item["url"], "messages": len(item["excerpt"])}
    return conv, entry


def main():
    now = datetime.now(timezone.utc)
    status_path = os.path.join(DATA, "status.json")
    index_path = os.path.join(DATA, "index.json")
    index = load(index_path, [])
    for c in index:
        c.setdefault("kind", "news")
    mode = (os.environ.get("MODE") or "auto").strip().lower()
    sug_url = os.environ.get("SUGGEST_URL", "").strip()
    sug_topic = os.environ.get("SUGGEST_TOPIC", "").strip()
    scheduled = os.environ.get("GITHUB_EVENT_NAME") == "schedule"

    if not os.environ.get("ANTHROPIC_API_KEY"):
        save(status_path, {"ok": False, "checked": now.isoformat(timespec="seconds"),
                           "note": "No ANTHROPIC_API_KEY secret set: nothing generated."})
        print("ANTHROPIC_API_KEY missing. Add it under Settings > Secrets and variables > Actions.", file=sys.stderr)
        return 1
    if not os.environ.get("OPENAI_API_KEY"):
        print("No OPENAI_API_KEY: Agent B will be a second Claude, and the page will say so.")

    if sug_url or sug_topic:
        jobs = ["news"]
    elif mode == "auto":
        jobs = [week_kind(now), "found"]
    else:
        jobs = [mode]
    if scheduled:
        jobs = [j for j in jobs if not recent(index, j, now)]

    notes, ok = [], True
    for job in jobs:
        usage = Usage()
        try:
            conv, entry = do_find(index, now, usage) if job == "found" else \
                do_conversation(job, index, now, usage, sug_url, sug_topic)
        except RuntimeError as e:
            ok = False
            notes.append(f"{job}: {e}")
            print(f"{job} failed: {e}", file=sys.stderr)
            continue
        conv["usage"] = usage.as_dict()
        save(os.path.join(CONV, conv["id"] + ".json"), conv)
        index.insert(0, entry)
        save(index_path, index)
        notes.append(f"{job}: {conv['id']}, {usage.calls} calls, about ${usage.cost()}")
        print(f"Saved {conv['id']} ({job}): {usage.calls} calls, ~${usage.cost()}")
    save(status_path, {"ok": ok, "checked": now.isoformat(timespec="seconds"), "note": " | ".join(notes) or "nothing due"})
    return 0 if ok else 1


def pick_from_ribbon(index, now, usage):
    feed = json.loads(http_get(FEED_URL)[0])
    try:
        gnews = json.loads(http_get(GNEWS_URL)[0])
    except Exception:  # noqa: BLE001
        gnews = {}
    used = {c["url"] for c in index}
    cands = candidates(feed, gnews, used, now)
    if not cands:
        raise RuntimeError("No recent, unused stories in the Global Health Ribbon feed.")
    i, why = pick_story(cands, [c["title"] for c in index if c.get("kind", "news") == "news"], usage)
    item = cands[i]
    text, source, final_url, pub_date = article_for(item)
    publisher, title = publisher_and_title(item, final_url)
    story = {"title": title, "publisher": publisher,
             "date": pub_date or item.get("date", "")[:10], "url": final_url,
             "ribbon_category": item.get("cat", ""), "text_source": source, "text": text,
             "pick_reason": why}
    print(f"Story: {story['title']} ({source}, {len(text)} chars)")
    return story, text


if __name__ == "__main__":
    sys.exit(main())
