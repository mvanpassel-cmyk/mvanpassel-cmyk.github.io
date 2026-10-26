#!/usr/bin/env python3
"""Lightweight integrity check for the good-practice portals and the NPHI map.

Checks only things that would silently break a page or mislabel evidence:
  - every data file parses as JSON
  - literature ids are unique and every source has title, url and type
  - a source's type is one the page knows how to label
  - cross-framework references (benchmark, SPAR, PHEPA, JEE ids) point to items that exist
  - NPHI map ids are unique and every entry has a source url and a checked date

No network, no dependencies. Run: python3 .github/scripts/check-data.py
Exit code 1 on errors; warnings are printed but do not fail.
"""
import json, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
errors, warnings = [], []


def load(rel):
    p = ROOT / rel
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        errors.append(f"{rel}: cannot parse ({e})")
        return None


def err(msg): errors.append(msg)
def warn(msg): warnings.append(msg)


# ---- reference id sets -------------------------------------------------------
bench = load("ihr-benchmarks-good-practices/data/benchmarks.json")
spar = load("spar-good-practices/data/spar.json")
phepa = load("phepa-good-practices/data/phepa.json")
jee = load("jee-good-practices/data/jee-v3-framework.json")

BM = {b["id"] for b in bench["benchmarks"]} if bench else set()
SPAR_IND = {i["id"] for i in spar["indicators"]} if spar else set()
SPAR_CAP = {c["id"] for c in spar["caps"]} if spar else set()
PHEPA_CAP = {str(c["id"]) for c in phepa["capacities"]} if phepa else set()


def jee_ids(o, out):
    if isinstance(o, dict):
        i = o.get("id")
        if isinstance(i, str) and len(i) <= 6 and any(ch.isdigit() for ch in i):
            out.add(i)
        for v in o.values():
            jee_ids(v, out)
    elif isinstance(o, list):
        for v in o:
            jee_ids(v, out)
    return out


JEE = jee_ids(jee, set()) if jee else set()

# ---- literature files --------------------------------------------------------
LIT = [
    "ihr-benchmarks-good-practices/data/literature.json",
    "spar-good-practices/data/literature.json",
    "ianphi-good-practices/data/literature.json",
    "tracss-good-practices/data/literature.json",
    "woah-pvs-good-practices/data/literature.json",
]
# SPAR labels types with the IHR benchmark type list
ihr_types = (load(LIT[0]) or {}).get("meta", {}).get("types", {})

for rel in LIT:
    d = load(rel)
    if not d:
        continue
    types = d.get("meta", {}).get("types") or ihr_types
    seen = set()
    for s in d.get("sources", []):
        sid = s.get("id", "?")
        if sid in seen:
            err(f"{rel}: duplicate id {sid}")
        seen.add(sid)
        for f in ("title", "url", "type"):
            if not s.get(f):
                err(f"{rel}: {sid} missing {f}")
        if s.get("type") and s["type"] not in types:
            warn(f"{rel}: {sid} has type '{s['type']}' with no label")
        if "pr" in s and not isinstance(s["pr"], bool):
            err(f"{rel}: {sid} pr must be true/false")
        for b in s.get("bm", []) or []:
            if BM and b not in BM:
                err(f"{rel}: {sid} links unknown IHR benchmark {b}")
        for i in s.get("ind", []) or []:
            if SPAR_IND and i not in SPAR_IND:
                err(f"{rel}: {sid} links unknown SPAR indicator {i}")

# ---- cross-framework references in topic files -------------------------------


def walk_refs(rel, o):
    if isinstance(o, dict):
        for c in o.get("spar", []) if isinstance(o.get("spar"), list) else []:
            if str(c) not in SPAR_IND | SPAR_CAP:
                err(f"{rel}: unknown SPAR reference {c}")
        for c in o.get("phepa", []) if isinstance(o.get("phepa"), list) else []:
            if str(c) not in PHEPA_CAP:
                err(f"{rel}: unknown PHEPA capacity {c}")
        for c in o.get("jee", []) if isinstance(o.get("jee"), list) else []:
            if isinstance(c, str) and JEE and c not in JEE:
                warn(f"{rel}: JEE id {c} not found in v3 framework")
        for v in o.values():
            walk_refs(rel, v)
    elif isinstance(o, list):
        for v in o:
            walk_refs(rel, v)


for rel in [
    "ianphi-good-practices/data/ianphi.json",
    "tracss-good-practices/data/tracss-2025.json",
    "woah-pvs-good-practices/data/data.json",
    "spar-good-practices/data/spar.json",
    "ihr-benchmarks-good-practices/data/benchmarks.json",
    "phepa-good-practices/data/phepa.json",
]:
    d = load(rel)
    if d:
        walk_refs(rel, d)

if spar:
    for i in spar["indicators"]:
        for b in i.get("bm", []):
            if b not in BM:
                err(f"spar.json: {i['id']} links unknown IHR benchmark {b}")

# ---- NPHI map ----------------------------------------------------------------
nphi = load("nphi-map/projects.json")
if nphi:
    seen = set()
    for p in nphi["projects"]:
        pid = p.get("id", "?")
        if pid in seen:
            err(f"nphi-map: duplicate id {pid}")
        seen.add(pid)
        if not p.get("url"):
            err(f"nphi-map: {pid} has no source url")
        if not p.get("checked"):
            warn(f"nphi-map: {pid} has no checked date")

for w in warnings:
    print("warning:", w)
for e in errors:
    print("ERROR:", e)
print(f"{len(errors)} errors, {len(warnings)} warnings")
sys.exit(1 if errors else 0)
