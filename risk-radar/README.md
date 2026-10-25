# Risk Radar

*Connecting the dots between emerging global risks.*

Live: https://mvanpassel-cmyk.github.io/risk-radar/

A static, evidence-first dashboard of institutional risk assessments: what institutions warn about, who says it, how they know (survey, modelling, observation), how risks connect, and what is new. See [METHODOLOGY.md](METHODOLOGY.md).

## Structure

```
risk-radar/
  index.html              the whole interface (no build step)
  data/
    sources.json          source registry (connectors + curated sources)
    taxonomy.json         domains, entity kinds, horizons, relation types
    risks.json            curated canonical risks with source assessments
    relations.json        documented and candidate links, with evidence
    curated-signals.json  hand-entered signals (publication dates)
    signals.json          detected publications (written by the pipeline)
    status.json           per-source check results (pipeline)
    changelog.json        runs with new items or failures (pipeline)
    state.json            seen-item hashes per source (pipeline)
    derived.json          attention, convergence, equal-weight ranking (pipeline)
    feed.xml              Atom feed (pipeline)
  schema/risk.schema.json
  pipeline/ingest.py      source checks, change detection, matching, feed
  pipeline/analysis.py    validation, attention, convergence, ranking
  tests/test_pipeline.py  unit tests (python -m unittest)
```

The workflow is `.github/workflows/risk-radar.yml` (daily at 05:41 UTC, on manual dispatch, and on pushes that change the pipeline or core data). Standard library only; no secrets needed.

## Maintenance

**Add a finding to an existing risk**: append an object to that risk's `assessments` in `data/risks.json` (source id, title, date at known precision, URL, method, independence group, verification, native rating, quantities, short quote). Push; CI validates it.

**Add a new risk**: add an object with a new stable id (`domain-short-name`), at least one assessment, `match` keywords, and optional `coding` (1–3 or null, with a note).

**Add a link**: add to `data/relations.json` with `documented` (a source states it) or `candidate` status and at least one evidence item.

**Add a source**: add to `data/sources.json`. For automation, give a `connector`:
- `{"type": "rss", "urls": [...], "merge": false, "filter": "regex"}`: first working URL wins (or all, with `merge`);
- `{"type": "page", "url": "...", "link": "regex on link path"}`: detects new publication links on a listing page.

**Run locally**

```
python3 -m unittest discover -s risk-radar/tests
python3 risk-radar/pipeline/analysis.py
python3 risk-radar/pipeline/ingest.py
python3 -m http.server -d . 8000   # then open http://localhost:8000/risk-radar/
```

**When a source fails**: its earlier data stays; the Sources page shows the error. Fix the URL or link pattern in `sources.json`.
