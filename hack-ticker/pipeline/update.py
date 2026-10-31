#!/usr/bin/env python3
"""Hack Ticker: keeps a timeline of cyber incidents with an impact class from 1 to 5.

Sources, read every few hours:
  - cyber security news feeds (data/feeds.json): counted per week as "news attention",
    and, when ANTHROPIC_API_KEY is set, read by an AI editor that turns them into incidents
  - Have I Been Pwned: confirmed data breaches with the number of accounts (CC BY 4.0)
  - DeFiLlama: crypto hacks with the amount stolen
  - ransomware.live: victims posted on ransomware leak sites, counted per week

Standard library only. Writes data/incidents.json, data/weekly.json, data/status.json.
"""
import hashlib, html, json, os, re, sys, time, urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
UA = "HackTicker/1.0 (+https://mvanpassel-cmyk.github.io/hack-ticker/)"
MODEL = os.environ.get("HACK_TICKER_MODEL", "claude-sonnet-5-5")
WINDOW_DAYS = 3
KEEP_SEEN_DAYS = 60
TYPES = ["Ransomware", "Data breach", "Crypto theft", "Disruption", "Espionage", "Supply chain", "Sabotage", "Mass exploitation", "Other"]
SECTORS = ["Health", "Government", "Finance", "Crypto", "Telecom", "Energy", "Transport", "Retail", "Tech",
           "Education", "Industry", "Media", "Defence", "Other"]
EU = {"AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU",
      "MT", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "NO", "IS", "CH", "GB", "UA"}
HACK_WORDS = re.compile(r"\b(hack|hacked|hacker|breach|leak|leaked|ransomware|cyber ?attack|cyberaanval|datalek|"
                        r"stolen|exploit|exploited|ddos|intrusion|compromised|extortion|malware|phishing|outage)\b", re.I)


# ---------- small helpers ----------
def load(name, default):
    try:
        with open(os.path.join(DATA, name), encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save(name, obj):
    path = os.path.join(DATA, name)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(path + ".tmp", path)


def key(s):
    s = re.sub(r"[?#].*$", "", s.strip().lower()).rstrip("/")
    return hashlib.sha1(s.encode()).hexdigest()[:16]


def clean(s, n=300):
    s = html.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= n else s[: n - 1].rsplit(" ", 1)[0] + "…"


def week(d):
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def region_of(cc):
    cc = (cc or "").upper()
    if cc == "NL":
        return "NL"
    return "EU" if cc in EU else "World"


def impact_people(n):
    if n is None:
        return None
    return 1 if n < 10_000 else 2 if n < 1_000_000 else 3 if n < 10_000_000 else 4 if n < 100_000_000 else 5


def impact_usd(v):
    if v is None:
        return None
    return 1 if v < 1_000_000 else 2 if v < 10_000_000 else 3 if v < 100_000_000 else 4 if v < 1_000_000_000 else 5


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


def get(url, timeout=30, accept="*/*"):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def local(tag):
    return tag.rsplit("}", 1)[-1]


def parse_feed(xml_bytes):
    root = ET.fromstring(xml_bytes)
    out = []
    for el in root.iter():
        if local(el.tag) not in ("item", "entry"):
            continue
        f = {local(c.tag): c for c in el}
        title = clean(f["title"].text if "title" in f else "", 220)
        url = ""
        for c in el:
            if local(c.tag) != "link":
                continue
            href = c.get("href")
            if href and c.get("rel", "alternate") == "alternate":
                url = href.strip()
                break
            if not href and (c.text or "").strip():
                url = c.text.strip()
                break
        if not url and "guid" in f and (f["guid"].text or "").startswith("http"):
            url = f["guid"].text.strip()
        desc = next((f[k].text for k in ("description", "summary", "encoded", "content") if k in f and f[k].text), "")
        date = next((parse_date(f[k].text) for k in ("pubDate", "published", "updated", "date") if k in f and f[k].text), None)
        if title and url.startswith("http"):
            out.append({"title": title, "url": url, "summary": clean(desc), "date": date})
    return out


# ---------- sources ----------
def from_hibp(now, incidents, status):
    """Confirmed breaches added to Have I Been Pwned in the last two weeks."""
    try:
        data = json.loads(get("https://haveibeenpwned.com/api/v3/breaches", accept="application/json"))
    except Exception as e:
        status["sources_failed"].append("Have I Been Pwned")
        print("HIBP failed:", e, file=sys.stderr)
        return 0
    have = {i["id"] for i in incidents}
    added = 0
    for b in data:
        added_at = parse_date(b.get("AddedDate"))
        if not added_at or added_at < now - timedelta(days=14) or b.get("IsSpamList") or b.get("IsFabricated"):
            continue
        iid = "hibp-" + b["Name"]
        if iid in have:
            continue
        n = b.get("PwnCount")
        tld = (b.get("Domain") or "").rsplit(".", 1)[-1].upper()
        cc = "GB" if tld == "UK" else tld if len(tld) == 2 else ""
        when = b.get("BreachDate") or added_at.strftime("%Y-%m-%d")
        incidents.append({
            "id": iid, "date": when, "added": now.strftime("%Y-%m-%d"),
            "title": f"{b.get('Title') or b['Name']}: {n:,} accounts in a confirmed data breach" if n else f"{b.get('Title') or b['Name']} data breach",
            "victim": b.get("Title") or b["Name"], "country": cc, "region": region_of(cc), "sector": "Other",
            "type": "Data breach", "impact": impact_people(n) or 2, "people": n, "usd": None, "confirmed": True,
            "summary": clean(b.get("Description"), 260),
            "sources": [{"name": "Have I Been Pwned", "url": f"https://haveibeenpwned.com/Breach/{b['Name']}"}],
            "via": "hibp"})
        added += 1
    return added


def from_llama(now, incidents, status):
    """Crypto hacks of $1M or more in the last 30 days, from DeFiLlama."""
    try:
        data = json.loads(get("https://api.llama.fi/hacks", accept="application/json"))
    except Exception as e:
        status["sources_failed"].append("DeFiLlama")
        print("DeFiLlama failed:", e, file=sys.stderr)
        return 0
    have = {i["id"] for i in incidents}
    added = 0
    for h in data if isinstance(data, list) else []:
        try:
            d = datetime.fromtimestamp(int(h.get("date", 0)), timezone.utc)
            amt = float(h.get("amount") or 0)
        except (TypeError, ValueError):
            continue
        if d < now - timedelta(days=30) or amt < 1_000_000:
            continue
        name = (h.get("name") or "").strip()
        iid = "llama-" + key(name + d.strftime("%Y-%m-%d"))
        if not name or iid in have:
            continue
        dup = similar(incidents, name, d)
        if dup:  # already on the timeline (e.g. from the news): add DeFiLlama as a source and the amount if missing
            if not any(s["name"] == "DeFiLlama" for s in dup["sources"]):
                dup["sources"].append({"name": "DeFiLlama", "url": "https://defillama.com/hacks"})
            dup["usd"] = dup.get("usd") or int(amt)
            continue
        tech = ", ".join(x for x in [h.get("classification"), h.get("technique")] if x)
        incidents.append({
            "id": iid, "date": d.strftime("%Y-%m-%d"), "added": now.strftime("%Y-%m-%d"),
            "title": f"{name}: ${amt/1e6:,.1f}M in crypto stolen", "victim": name, "country": "", "region": "World",
            "sector": "Crypto", "type": "Crypto theft", "impact": impact_usd(amt), "people": None, "usd": int(amt),
            "confirmed": True, "summary": clean(tech, 200),
            "sources": [{"name": "DeFiLlama", "url": "https://defillama.com/hacks"}] +
                       ([{"name": "Report", "url": h["source"]}] if str(h.get("source", "")).startswith("http") else []),
            "via": "defillama"})
        added += 1
    return added


def ransomware_counts(now, weekly, status, rw_seen):
    """Count new victims posted on ransomware leak sites (ransomware.live, free personal-use API)."""
    try:
        data = json.loads(get("https://api.ransomware.live/v2/recentvictims", accept="application/json"))
    except Exception as e:
        status["sources_failed"].append("ransomware.live")
        print("ransomware.live failed:", e, file=sys.stderr)
        return 0
    n = 0
    for v in data if isinstance(data, list) else []:
        vid = key(f"{v.get('group') or v.get('group_name')}|{v.get('victim') or v.get('post_title')}")
        if vid in rw_seen:
            continue
        d = parse_date(v.get("discovered") or v.get("attackdate") or v.get("published")) or now
        rw_seen[vid] = now.strftime("%Y-%m-%d")
        w = week(d)
        weekly["ransomware"][w] = weekly["ransomware"].get(w, 0) + 1
        if (v.get("country") or "").upper() == "NL":
            weekly["ransomware_nl"][w] = weekly["ransomware_nl"].get(w, 0) + 1
        n += 1
    return n


def tokens(s):
    return {t for t in re.findall(r"[a-z0-9]+", (s or "").lower()) if len(t) >= 4 and t not in {"finance", "protocol", "exchange", "network", "crypto"}}


def similar(incidents, name, d, days=4):
    n = tokens(name)
    for i in incidents:
        try:
            di = datetime.fromisoformat(i["date"][:10]).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if abs((di - d).days) <= days and n & (tokens(i.get("victim")) | tokens(i.get("title"))):
            return i
    return None
    return False


# ---------- AI editor ----------
RUBRIC = (
    "Impact class: 1 minor (one small organisation, under 10,000 people, little disruption); "
    "2 limited (up to 1 million people, local disruption, under $10M); "
    "3 significant (1-10 million people, regional services disrupted for days, $10-100M, or a national chain hit); "
    "4 major (10-100 million people, national critical services such as hospitals, energy, telecom or government disrupted, "
    "$100M-1B, or state espionage against governments); "
    "5 severe (over 100 million people, disruption across several countries, over $1B, or risk to life). "
    "Unconfirmed claims by criminal groups get at most class 3 until confirmed.")


def ask_claude(cands, recent):
    lines = [f"[{i}] {c['source']} | {c['date'].strftime('%Y-%m-%d') if c['date'] else '?'} | {c['title']} | {c['summary'][:240]}"
             for i, c in enumerate(cands)]
    known = [f"{i['id']} | {i['date']} | {i['title']}" for i in recent]
    system = ("You are the editor of Hack Ticker, a timeline of real cyber incidents. From security news headlines you "
              "identify concrete incidents: an attack, breach, theft, leak or disruption that happened to a named "
              "organisation, country or service. Also include software flaws confirmed to be exploited at scale (type Mass exploitation). "
              "Ignore advice, product news, vulnerability write-ups without confirmed exploitation, "
              "arrests, opinion and trend reports. Merge headlines about the same incident. " + RUBRIC)
    user = ("Incidents already on the timeline (use same_as to add a new source to one of these instead of repeating it):\n"
            + "\n".join(known[:120]) + "\n\nNew headlines:\n" + "\n".join(lines) +
            "\n\nReturn JSON only: {\"incidents\":[{\"i\":[headline indexes],\"same_as\":\"existing id or null\","
            "\"date\":\"YYYY-MM-DD the incident happened or was disclosed\",\"title\":\"neutral headline in your own words, max 12 words\","
            "\"victim\":\"organisation or service\",\"country\":\"ISO 3166 alpha-2 of the victim, or empty\","
            f"\"sector\":\"one of {', '.join(SECTORS)}\",\"type\":\"one of {', '.join(TYPES)}\","
            "\"impact\":1-5,\"people\":number of people or accounts affected or null,\"usd\":money stolen or demanded in USD or null,"
            "\"confirmed\":true if the victim or authorities confirmed it,"
            "\"summary\":\"one sentence in your own words, max 30 words\"}]}")
    body = json.dumps({"model": MODEL, "max_tokens": 4000, "system": system,
                       "messages": [{"role": "user", "content": user}]}).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, headers={
        "x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01", "content-type": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                res = json.load(r)
            return "".join(b.get("text", "") for b in res.get("content", []) if b.get("type") == "text")
        except Exception as e:
            print(f"Claude call failed ({e}), attempt {attempt + 1}", file=sys.stderr)
            time.sleep(10 * (attempt + 1))
    raise RuntimeError("Claude API unavailable")


def parse_incidents(text, cands, known_ids, now):
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return []
    try:
        obj = json.loads(m.group(0))
    except json.JSONDecodeError:
        return []
    out = []
    for x in obj.get("incidents", []):
        idx = [i for i in x.get("i", []) if isinstance(i, int) and 0 <= i < len(cands)]
        if not idx:
            continue
        srcs = [{"name": cands[i]["source"], "url": cands[i]["url"]} for i in idx]
        same = x.get("same_as")
        if same and same in known_ids:
            out.append({"same_as": same, "sources": srcs})
            continue
        try:
            imp = max(1, min(5, int(x.get("impact", 1))))
        except (TypeError, ValueError):
            imp = 1
        title = clean(x.get("title", ""), 120)
        if not title:
            continue
        date = str(x.get("date") or "")[:10]
        if not re.match(r"\d{4}-\d{2}-\d{2}$", date):
            date = (cands[idx[0]]["date"] or now).strftime("%Y-%m-%d")
        cc = str(x.get("country") or "").upper()[:2]
        num = lambda v: int(v) if isinstance(v, (int, float)) and v > 0 else None
        confirmed = bool(x.get("confirmed"))
        if not confirmed:
            imp = min(imp, 3)
        out.append({
            "id": "n-" + key(srcs[0]["url"]), "date": date, "added": now.strftime("%Y-%m-%d"), "title": title,
            "victim": clean(x.get("victim", ""), 80), "country": cc, "region": region_of(cc),
            "sector": x.get("sector") if x.get("sector") in SECTORS else "Other",
            "type": x.get("type") if x.get("type") in TYPES else "Other", "impact": imp,
            "people": num(x.get("people")), "usd": num(x.get("usd")), "confirmed": confirmed,
            "summary": clean(x.get("summary", ""), 240), "sources": srcs, "via": "news"})
    return out


# ---------- main ----------
def main():
    now = datetime.now(timezone.utc)
    feeds = load("feeds.json", [])
    incidents = load("incidents.json", [])
    weekly = load("weekly.json", {})
    for k in ("news", "ransomware", "ransomware_nl"):
        weekly.setdefault(k, {})
    seen = load("seen.json", {})
    counted, reviewed, rw_seen = seen.setdefault("counted", {}), seen.setdefault("reviewed", {}), seen.setdefault("ransomware", {})
    ai = bool(os.environ.get("ANTHROPIC_API_KEY"))
    status = {"last_run": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "feeds_ok": 0, "feeds_failed": [], "sources_failed": [],
              "news_new": 0, "incidents_added": 0, "ai": ai, "model": MODEL}

    # 1) news: count every new hack-related headline per week, collect recent ones for the editor
    cands = []
    for f in feeds:
        try:
            items = parse_feed(get(f["url"], accept="application/rss+xml, application/atom+xml, application/xml, */*;q=0.5"))
            status["feeds_ok"] += 1
        except Exception as e:
            status["feeds_failed"].append(f["name"])
            print(f"feed failed: {f['name']}: {e}", file=sys.stderr)
            continue
        for it in items[:50]:
            k = key(it["url"])
            relevant = HACK_WORDS.search(it["title"] + " " + it["summary"])
            if k not in counted:
                counted[k] = now.strftime("%Y-%m-%d")
                if relevant:
                    w = week(it["date"] or now)
                    weekly["news"][w] = weekly["news"].get(w, 0) + 1
                    status["news_new"] += 1
            if relevant and k not in reviewed and (not it["date"] or it["date"] >= now - timedelta(days=WINDOW_DAYS)):
                it.update(source=f["name"], key=k)
                cands.append(it)

    # 2) structured sources
    status["incidents_added"] += from_hibp(now, incidents, status)
    status["incidents_added"] += from_llama(now, incidents, status)
    status["ransomware_new"] = ransomware_counts(now, weekly, status, rw_seen)

    # 3) AI editor turns headlines into incidents
    if ai and cands:
        cands = sorted(cands, key=lambda c: c["date"] or now, reverse=True)[:180]
        cutoff = (now - timedelta(days=45)).strftime("%Y-%m-%d")
        recent = [i for i in incidents if i["date"] >= cutoff]
        try:
            found = parse_incidents(ask_claude(cands, recent), cands, {i["id"] for i in incidents}, now)
            byid = {i["id"]: i for i in incidents}
            for x in found:
                if "same_as" in x:
                    tgt = byid[x["same_as"]]
                    urls = {s["url"] for s in tgt["sources"]}
                    tgt["sources"] += [s for s in x["sources"] if s["url"] not in urls][:6]
                elif x["id"] not in byid:
                    incidents.append(x)
                    byid[x["id"]] = x
                    status["incidents_added"] += 1
            for c in cands:
                reviewed[c["key"]] = now.strftime("%Y-%m-%d")
        except RuntimeError as e:
            status["note"] = str(e)
    elif not ai:
        status["note"] = "No ANTHROPIC_API_KEY secret: news is counted but not turned into incidents."

    keep = (now - timedelta(days=KEEP_SEEN_DAYS)).strftime("%Y-%m-%d")
    for d in (counted, reviewed, rw_seen):
        for k in [k for k, v in d.items() if v < keep]:
            del d[k]
    incidents.sort(key=lambda i: (i["date"], i.get("impact", 0)), reverse=True)
    save("incidents.json", incidents[:5000])
    save("weekly.json", weekly)
    save("seen.json", seen)
    save("status.json", status)
    print(json.dumps(status, indent=1))


if __name__ == "__main__":
    main()
