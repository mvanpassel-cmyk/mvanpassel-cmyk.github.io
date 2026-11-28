#!/usr/bin/env python3
"""Write shared/tool-updates.json: when each tool on the landing page last changed.

Only changes to the tool itself count. Ignored:
  - commits by bots (author name ending in "bot" / "[bot]"), i.e. the data refreshes
  - commits that only touch data: anything under data/ or archief/, and .json/.csv/.md files
  - tiny edits (fewer than MIN_LINES changed lines in the tool), e.g. a counter or favicon
    tag added to every tool at once

Tools that live in this repo are read from git history (needs a full-history checkout).
Tools in their own repo (no folder here) are read from the GitHub API.
"""
import json, os, re, subprocess, sys, urllib.request
from datetime import datetime, timezone

OWNER = "mvanpassel-cmyk"
OUT = "shared/tool-updates.json"
BOT = re.compile(r"(\bbot|\[bot\])$", re.I)
DATA_DIR = re.compile(r"(^|/)(data|archief)/")
DATA_EXT = (".json", ".csv", ".md")
ICON = re.compile(r"(favicon|icon|logo)[^/]*\.(png|ico|svg)$", re.I)
MIN_LINES = 6


def is_data(path):
    return bool(DATA_DIR.search(path)) or path.lower().endswith(DATA_EXT)


def significant(changes):
    """changes: list of (path, lines changed or None for binary). True if it is a real tool change."""
    lines = 0
    for path, n in changes:
        if is_data(path):
            continue
        if n is None:                      # binary file: samples, images...
            if not ICON.search(path):
                return True
            continue
        lines += n
    return lines >= MIN_LINES


def tools_on_landing_page():
    html = open("index.html", encoding="utf-8").read()
    return list(dict.fromkeys(re.findall(r'repo:"([^"]+)"', html)))


def local_last_change(folder):
    # One record per commit: header line, then "added<TAB>deleted<TAB>path" per file.
    out = subprocess.run(
        ["git", "log", "--format=%x1e%an%x1f%cI", "--numstat", "--", folder + "/"],
        capture_output=True, text=True, check=True).stdout
    for rec in out.split("\x1e"):
        lines = [l for l in rec.strip().split("\n") if l.strip()]
        if not lines:
            continue
        author, date = lines[0].split("\x1f")
        if BOT.search(author.strip()):
            continue
        changes = []
        for l in lines[1:]:
            a, d, path = l.split("\t", 2)
            n = None if a == "-" else int(a) + int(d)
            changes.append((path[len(folder) + 1:], n))
        if significant(changes):
            return date
    return None


def api(url):
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json"})
    tok = os.environ.get("GITHUB_TOKEN")
    if tok:
        req.add_header("Authorization", "Bearer " + tok)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def remote_last_change(repo, max_checks=25):
    commits = api(f"https://api.github.com/repos/{OWNER}/{repo}/commits?per_page=100")
    checked = 0
    for c in commits:
        author = (c.get("commit", {}).get("author") or {}).get("name", "")
        login = (c.get("author") or {}).get("login", "") or ""
        if BOT.search(author.strip()) or login.endswith("[bot]"):
            continue
        if checked >= max_checks:
            break
        checked += 1
        files = api(c["url"]).get("files", [])
        changes = [(f["filename"], f.get("changes") if "patch" in f else None) for f in files]
        if not files or significant(changes):
            return c["commit"]["committer"]["date"]
    return None


def main():
    old = {}
    if os.path.exists(OUT):
        old = json.load(open(OUT, encoding="utf-8")).get("tools", {})
    result = {}
    for repo in tools_on_landing_page():
        try:
            date = local_last_change(repo) if os.path.isdir(repo) else remote_last_change(repo)
        except Exception as e:  # keep the previous value rather than losing it
            print(f"{repo}: {e}", file=sys.stderr)
            date = old.get(repo)
        if date:
            # Normalise to UTC ISO, seconds precision
            d = datetime.fromisoformat(date.replace("Z", "+00:00")).astimezone(timezone.utc)
            result[repo] = d.strftime("%Y-%m-%dT%H:%M:%SZ")
        print(f"{repo:32} {result.get(repo, '-')}")
    if result == old:
        print("No changes")
        return
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                   "tools": result}, f, indent=1, sort_keys=True)
        f.write("\n")


if __name__ == "__main__":
    main()
