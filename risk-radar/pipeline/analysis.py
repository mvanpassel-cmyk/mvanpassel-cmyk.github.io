#!/usr/bin/env python3
"""Derived analysis for Risk Radar: validation, attention/convergence and the experimental ranking.

Writes data/derived.json. Everything here is Risk Radar's own analysis, kept
separate from source-reported findings.
"""
import datetime as dt
import itertools
import json
import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

KINDS = {"hazard", "risk", "ongoing event", "vulnerability", "signal", "assessment"}
HORIZONS = {"12m", "1-5y", "5-20y"}
GEOS = {"global", "europe", "netherlands"}
DOMAINS = {"ai", "health", "food", "climate", "geopolitics", "cyber", "economy", "finance", "energy", "education", "governance"}
REL_TYPES = {"same", "driver", "cascade", "vulnerability", "contradiction", "correlated"}
CRITERIA = ("impact", "likelihood", "confidence", "preparedness")


# ---------------------------------------------------------------- validation
def validate(risks, relations, sources):
    """Return a list of human-readable problems (empty = valid)."""
    errs = []
    src_ids = {s["id"] for s in sources}
    ids = set()
    for r in risks:
        rid = r.get("id", "?")
        for f in ("id", "title", "summary", "kind", "domains", "geo", "horizon", "assessments"):
            if not r.get(f):
                errs.append(f"{rid}: missing {f}")
        if rid in ids:
            errs.append(f"{rid}: duplicate id")
        ids.add(rid)
        if r.get("kind") not in KINDS:
            errs.append(f"{rid}: unknown kind {r.get('kind')}")
        errs += [f"{rid}: unknown domain {d}" for d in r.get("domains", []) if d not in DOMAINS]
        errs += [f"{rid}: unknown geo {g}" for g in r.get("geo", []) if g not in GEOS]
        errs += [f"{rid}: unknown horizon {h}" for h in r.get("horizon", []) if h not in HORIZONS]
        for a in r.get("assessments", []):
            if a.get("source") not in src_ids:
                errs.append(f"{rid}: assessment cites unknown source {a.get('source')}")
            if not str(a.get("url", "")).startswith("https://"):
                errs.append(f"{rid}: assessment without https source URL")
            if not a.get("date"):
                errs.append(f"{rid}: assessment without date")
            if not a.get("independence"):
                errs.append(f"{rid}: assessment without independence group")
            for q in a.get("quant", []):
                if q.get("value") in (None, "", 0) or not q.get("unit") or not q.get("measure"):
                    errs.append(f"{rid}: incomplete quantity {q}")
            if a.get("quote") and len(a["quote"].split()) > 30:
                errs.append(f"{rid}: quotation longer than 30 words")
        c = r.get("coding")
        if c:
            for k in CRITERIA:
                if c.get(k) not in (None, 1, 2, 3):
                    errs.append(f"{rid}: coding {k} must be 1-3 or null")
    for rel in relations:
        if rel.get("from") not in ids or rel.get("to") not in ids:
            errs.append(f"{rel.get('id')}: relation points to unknown risk")
        if rel.get("type") not in REL_TYPES:
            errs.append(f"{rel.get('id')}: unknown relation type {rel.get('type')}")
        if rel.get("status") not in ("documented", "candidate"):
            errs.append(f"{rel.get('id')}: status must be documented or candidate")
        if not rel.get("evidence"):
            errs.append(f"{rel.get('id')}: relation without evidence")
    return errs


# ---------------------------------------------------------------- attention / convergence
def _date(s):
    s = str(s)
    parts = (s + "-01-01")[:10] if len(s) == 4 else (s + "-01")[:10] if len(s) == 7 else s[:10]
    return dt.date.fromisoformat(parts)


def attention(risk, today, window_days=1095):
    """Independent institutional attention within a time window.

    Counts distinct independence groups (assessments that derive from the same
    data or publication share a group), not raw mentions. Returns a dict.
    """
    recent = [a for a in risk["assessments"] if (today - _date(a["date"])).days <= window_days]
    groups = {a["independence"] for a in recent}
    methods = {a["method"].split(" (")[0] for a in recent}
    return {"independent": len(groups), "mentions": len(recent), "methods": sorted(methods),
            "quantified": any(a.get("quant") for a in risk["assessments"])}


def convergence_index(risk, today, window_days=1095):
    """0-1 index of independent corroboration: distinct groups and distinct methods, saturating.

    It measures corroboration/attention, not danger. 1 independent source = 0.
    """
    att = attention(risk, today, window_days)
    g, m = att["independent"], len(att["methods"])
    if g <= 1:
        return 0.0
    return round(min(1.0, 0.6 * (g - 1) / 3 + 0.4 * (m - 1) / 2), 2)


# ---------------------------------------------------------------- experimental ranking
def mcda(risks, weights):
    """Weighted mean of ordinal codes (1-3). Risks missing any weighted criterion stay unranked.

    'preparedness' is coded as a preparedness gap (3 = least prepared), so higher always means
    'more reason for attention' under the chosen weights.
    """
    active = {k: w for k, w in weights.items() if w > 0}
    scored, unranked = [], []
    total = sum(active.values())
    for r in risks:
        c = r.get("coding") or {}
        if not active or any(c.get(k) is None for k in active):
            unranked.append(r["id"])
            continue
        scored.append((round(sum(c[k] * w for k, w in active.items()) / total, 3), r["id"]))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [rid for _, rid in scored], dict((rid, s) for s, rid in scored), unranked


def sensitivity(risks, weights, runs=300, spread=0.5, seed=7):
    """Rank range per risk when each weight is randomly scaled by ±spread. Deterministic (seeded)."""
    rng = random.Random(seed)
    ranks = {}
    for _ in range(runs):
        w = {k: max(0.0, v * (1 + rng.uniform(-spread, spread))) for k, v in weights.items()}
        order, _, _ = mcda(risks, w)
        for i, rid in enumerate(order, 1):
            ranks.setdefault(rid, []).append(i)
    return {rid: [min(v), max(v)] for rid, v in ranks.items()}


def main():
    risks = json.load(open(os.path.join(DATA, "risks.json"), encoding="utf-8"))["risks"]
    relations = json.load(open(os.path.join(DATA, "relations.json"), encoding="utf-8"))["relations"]
    sources = json.load(open(os.path.join(DATA, "sources.json"), encoding="utf-8"))["sources"]
    errs = validate(risks, relations, sources)
    if errs:
        print("VALIDATION FAILED:\n  " + "\n  ".join(errs))
        return 1
    today = dt.date.today()
    eq = {k: 1 for k in CRITERIA}
    order, scores, unranked = mcda(risks, eq)
    out = {"generated": today.isoformat(), "windowDays": 1095,
           "risks": {r["id"]: dict(attention(r, today), convergence=convergence_index(r, today)) for r in risks},
           "equalWeights": {"order": order, "scores": scores, "unranked": unranked, "rankRange": sensitivity(risks, eq)}}
    json.dump(out, open(os.path.join(DATA, "derived.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"valid: {len(risks)} risks, {len(relations)} relations; derived.json written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
