#!/usr/bin/env python3
"""Monthly link check for the good-practice portals and the NPHI map.

Reads every http(s) URL in the portals' data files, requests each one the way a
browser would (HEAD, then GET), retries failures once, and writes
.github/link-report/report.json and report.md. It never edits portal data:
the monthly portal update reads the report and repairs the broken links.

Statuses:
  ok           2xx/3xx
  broken       404 or 410 twice: the page is gone or moved
  blocked      401/403/429 and other 4xx: the site refuses bots; usually fine for people
  server_error 5xx: often temporary (WHO's extranet does this to bots)
  unreachable  DNS, TLS or connection failure, or a timeout

Standard library only. Run: python3 .github/scripts/check-links.py
"""
import concurrent.futures as cf
import datetime as dt
import glob
import json
import pathlib
import re
import ssl
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / ".github" / "link-report"
FILES = sorted(glob.glob(str(ROOT / "*-good-practices" / "data" / "*.json"))) + [
    str(ROOT / "shared" / "programmes.json"),
    str(ROOT / "nphi-map" / "projects.json"),
]
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
HEADERS = {"User-Agent": UA, "Accept": "text/html,application/pdf,*/*;q=0.8", "Accept-Language": "en"}
CTX = ssl.create_default_context()
URL = re.compile(r'"(https?://[^"\s]+)"')


def collect():
    urls = {}
    for f in FILES:
        p = pathlib.Path(f)
        if not p.exists():
            continue
        tool = p.parts[-3] if p.parent.name == "data" else p.parent.name
        for u in URL.findall(p.read_text(encoding="utf-8")):
            urls.setdefault(u, set()).add(tool)
    return urls


def request(url):
    last = None
    for method in ("HEAD", "GET"):
        try:
            req = urllib.request.Request(url, method=method, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=25, context=CTX) as r:
                return r.status, r.geturl()
        except urllib.error.HTTPError as e:
            last = (e.code, "")
            if method == "HEAD":
                continue          # many servers refuse HEAD; try GET before judging
            return last
        except Exception as e:  # noqa: BLE001
            last = ("ERR " + type(e).__name__, "")
            if method == "HEAD":
                continue
    return last


def classify(code):
    if isinstance(code, int):
        if code < 400:
            return "ok"
        if code in (404, 410):
            return "broken"
        if code in (401, 403, 429):
            return "blocked"
        if code >= 500:
            return "server_error"
        return "blocked"          # other 4xx (405, 409, 418…) are bot defences, not missing pages
    return "unreachable"


def check(url):
    code, final = request(url)
    status = classify(code)
    if status in ("broken", "unreachable", "server_error"):
        time.sleep(2)
        code, final = request(url)   # one retry: rule out a hiccup
        status = classify(code)
    return url, status, code, final


def main():
    urls = collect()
    started = dt.datetime.now(dt.timezone.utc)
    rows = []
    with cf.ThreadPoolExecutor(16) as ex:
        for url, status, code, final in ex.map(check, sorted(urls)):
            row = {"url": url, "status": status, "code": code, "tools": sorted(urls[url])}
            if final and final != url:
                row["redirect"] = final
            rows.append(row)
    counts = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    OUT.mkdir(parents=True, exist_ok=True)
    problems = [r for r in rows if r["status"] != "ok"]
    (OUT / "report.json").write_text(json.dumps({
        "checked": started.isoformat(timespec="seconds"),
        "total": len(rows), "counts": counts,
        "problems": sorted(problems, key=lambda r: (r["status"], r["tools"], r["url"])),
    }, indent=1, ensure_ascii=False))
    order = ["broken", "unreachable", "server_error", "blocked"]
    lines = [f"# Portal link check, {started:%Y-%m-%d}", "",
             f"{len(rows)} links checked: " + ", ".join(f"{counts.get(k, 0)} {k}" for k in ["ok"] + order) + ".", "",
             "Broken links need a new URL; unreachable and server errors are often temporary; "
             "blocked sites refuse bots but usually work in a browser.", ""]
    for k in order:
        group = [r for r in problems if r["status"] == k]
        if not group:
            continue
        lines += [f"## {k} ({len(group)})", ""]
        lines += [f"- {r['code']} · {', '.join(r['tools'])} · {r['url']}" for r in group]
        lines.append("")
    (OUT / "report.md").write_text("\n".join(lines))
    print(f"{len(rows)} links: {counts}")


if __name__ == "__main__":
    main()
