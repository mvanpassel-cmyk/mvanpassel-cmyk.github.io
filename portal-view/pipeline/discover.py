#!/usr/bin/env python3
"""Portal View: find candidate live cameras on YouTube (run by hand, not in the weekly check).

Runs live-only YouTube searches for many places and themes, drops obvious
non-cameras (news, music, games, talk shows) and streams already in cams.json,
checks that each remaining video may be embedded, and writes candidates.json
for a person (or Claude) to review and geotag before anything goes on the page.

Usage: python portal-view/pipeline/discover.py queries.txt candidates.json
Standard library only.
"""
import json, os, re, sys, time, urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check  # noqa: E402

NOT_A_CAM = re.compile(
    r"\b(news|tv live|television|channel live|radio|music|lofi|lo-fi|beats|playlist|song|dj|concert|gaming|gameplay|"
    r"minecraft|fortnite|roblox|podcast|talk|interview|sermon|mass\b|worship|prayer|quran|bible|asmr|sleep|"
    r"relax(ing)? music|meditation|white noise|rain sounds|ambience|ambient|chill|study|stock|crypto|bitcoin|"
    r"trading|forex|election|match|vs\.?|football|cricket|soccer|nba|nfl|ufc|race live|f1|replay|rerun|"
    r"recorded|highlights|loop|drone footage|4k walk|walking tour|walk\b|tour\b|movie|cartoon|kids|anime|"
    r"shopping|sale|giveaway|scanner|police|atc\b|air traffic control|flight tracker|radar|earthquake|"
    r"tsunami warning|war|missile|attack|protest)\b", re.I)
LOOKS_LIKE_CAM = re.compile(r"(cam\b|cams\b|webcam|camera|c\u00e1mara|c\u00e2mera|live view|live stream|livestream|live from|\blive\b|"
                            r"en vivo|ao vivo|en direct|tr\u1ef1c ti\u1ebfp|\u76f4\u64ad|\u5b9e\u65f6|\u30e9\u30a4\u30d6|\uc2e4\uc2dc\uac04)", re.I)


def owner_names(html):
    """{videoId: channel name} from a results page (the shared parser keeps only the channel id)."""
    out = {}
    for m in re.finditer(r'"videoId":"([\w-]{11})".{0,4000}?"ownerText":\{"runs":\[\{"text":"([^"]+)"', html, re.S):
        out.setdefault(m.group(1), m.group(2))
    return out


def search(query):
    url = ("https://www.youtube.com/results?search_query=" + urllib.parse.quote(query) +
           "&sp=EgJAAQ%253D%253D&hl=en&gl=US")
    try:
        html = check.get(url)
    except Exception:  # noqa: BLE001
        return []
    res = check.parse_live_results(html) or []
    names = owner_names(html)
    return [(v, t, ch, names.get(v, "")) for v, t, ch in res]


def main(qfile, out):
    queries = [q.strip() for q in open(qfile, encoding="utf-8") if q.strip() and not q.startswith("#")]
    have = {c["yt"] for c in json.load(open(check.CAMS, encoding="utf-8"))["cams"]}
    if os.environ.get("SEEN"):
        have |= set(json.load(open(os.environ["SEEN"])))
    found = {}
    for i, q in enumerate(queries):
        for v, t, ch, name in search(q):
            if v in have or v in found:
                continue
            if NOT_A_CAM.search(t) or not LOOKS_LIKE_CAM.search(t):
                continue
            found[v] = {"yt": v, "title": t, "ch": ch, "by": name, "q": q}
        if i % 25 == 0:
            print(f"{i}/{len(queries)} queries, {len(found)} candidates", flush=True)
        time.sleep(0.8)
    ok = []
    for c in found.values():
        if check.embeddable(c["yt"]) == "ok":
            ok.append(c)
        time.sleep(0.2)
    json.dump(ok, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{len(found)} candidates, {len(ok)} embeddable -> {out}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
