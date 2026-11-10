#!/usr/bin/env python3
"""Portal View: weekly health check of the camera list (cams.json).

YouTube blocks scripted visits to its video pages from servers, so this check
uses two things that do work without a key:
  1. oEmbed, which says whether a video still exists and may be embedded.
  2. A live-only search for the camera's own title. If the same video turns up it
     is live. If the same channel now streams it under a new video id, the camera
     is repaired. If it is missing two weeks in a row it is marked "off" and the
     page skips it.
A camera that comes back is switched on again, and nothing is ever deleted, so a
seasonal camera (a nest, a ski slope) returns by itself. The page also protects
itself: when the player reports an error it moves on to another camera.
Standard library only.
"""
import json, os, re, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAMS = os.path.join(HERE, "cams.json")
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+667; SOCS=CAI",
}


def get(url, timeout=30):
    with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def embeddable(video_id):
    """'ok' | 'no-embed' | 'gone' | 'unknown' from YouTube's oEmbed endpoint."""
    url = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote("https://www.youtube.com/watch?v=" + video_id, safe="")
    try:
        get(url, 20)
        return "ok"
    except urllib.error.HTTPError as e:
        return {401: "no-embed", 403: "no-embed", 404: "gone", 400: "gone"}.get(e.code, "unknown")
    except Exception:  # noqa: BLE001
        return "unknown"


def parse_live_results(html):
    """[(videoId, title, channelId)] of the live videos on a search results page."""
    m = re.search(r"var ytInitialData = (\{.*?\});</script>", html, re.S)
    if not m:
        return None
    out = []

    def walk(o):
        if isinstance(o, dict):
            v = o.get("videoRenderer")
            if v and any("LIVE" in json.dumps(b) for b in v.get("badges", [])):
                try:
                    out.append((v["videoId"], "".join(r["text"] for r in v["title"]["runs"]),
                                v["ownerText"]["runs"][0]["navigationEndpoint"]["browseEndpoint"]["browseId"]))
                except (KeyError, TypeError, IndexError):
                    pass
            for x in o.values():
                walk(x)
        elif isinstance(o, list):
            for x in o:
                walk(x)
    walk(json.loads(m.group(1)))
    return out


def live_search(query):
    """Live videos for a query, or None when the page could not be read."""
    url = "https://www.youtube.com/results?search_query=" + urllib.parse.quote(query) + "&sp=EgJAAQ%253D%253D&hl=en&gl=US"
    try:
        return parse_live_results(get(url))
    except Exception:  # noqa: BLE001
        return None


def words(title):
    return set(re.findall(r"[a-z0-9]{3,}", (title or "").lower()))


def best_match(wanted_title, streams):
    """Pick the live stream whose title shares most words with the old one (at least half)."""
    want = words(wanted_title)
    best, score = None, 0.0
    for vid, title in streams:
        have = words(title)
        s = len(want & have) / max(1, len(want))
        if s > score:
            best, score = vid, s
    return best if score >= 0.5 else None


def judge(cam, emb, results):
    """Decide one camera's state from its oEmbed answer and its live-search results.
    Returns (state, new_video_id): state is 'live' | 'repaired' | 'missing' | 'no-embed' | 'gone' | 'unknown'."""
    if emb in ("no-embed", "gone"):
        # the old video is unusable; the channel may have restarted the stream under a new id
        if results:
            new = best_match(cam.get("src", ""), [(v, t) for v, t, ch in results if ch == cam.get("ch") and v != cam["yt"]])
            if new:
                return "repaired", new
        return emb, None
    if results is None or emb == "unknown":
        return "unknown", None
    if any(v == cam["yt"] for v, _t, _c in results):
        return "live", None
    new = best_match(cam.get("src", ""), [(v, t) for v, t, ch in results if ch == cam.get("ch")])
    if new:
        return "repaired", new
    return "missing", None


def main():
    data = json.load(open(CAMS, encoding="utf-8"))
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    counts = {"live": 0, "repaired": 0, "off": 0, "unknown": 0}
    verdicts = []
    for cam in data["cams"]:
        emb = embeddable(cam["yt"])
        results = live_search(cam.get("src") or f"{cam['place']} live cam")
        verdicts.append(judge(cam, emb, results))
        time.sleep(1.0)
    if verdicts and sum(1 for v in verdicts if v[0] == "unknown") > len(verdicts) * 0.5:
        print("More than half of the checks were inconclusive (YouTube is probably blocking this runner); nothing changed.")
        return 0
    for cam, (state, new) in zip(data["cams"], verdicts):
        if state == "unknown":
            counts["unknown"] += 1
            continue
        if state == "repaired" and embeddable(new) == "ok":
            cam["yt"], state = new, "live"
            counts["repaired"] += 1
        if state == "live":
            cam.pop("off", None)
            cam.pop("miss", None)
            cam["ok"] = today
            counts["live"] += 1
        elif state == "missing":
            cam["miss"] = cam.get("miss", 0) + 1       # a search can simply miss a stream once
            if cam["miss"] >= 2:
                cam["off"] = "not-live"
                counts["off"] += 1
            else:
                counts["live"] += 1
        else:
            cam["off"] = state if state != "repaired" else "no-embed"
            counts["off"] += 1
    data["checked"] = today
    data["counts"] = counts
    tmp = CAMS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, CAMS)
    print(json.dumps(counts))
    return 0


if __name__ == "__main__":
    sys.exit(main())
