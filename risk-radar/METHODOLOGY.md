# Risk Radar methodology

Risk Radar brings together risk assessments published by institutions, keeps every finding tied to its source, and adds a clearly separated layer of its own analysis. Its central rule: **evidence about a risk is not the same as attention paid to it.**

## 1. Two layers

| Layer | What it contains | Where it lives |
|---|---|---|
| Source findings | Ratings, numbers, horizons and short quotations as published, in the source's own scale and units | `data/risks.json` → `assessments` |
| Risk Radar analysis | Attention counts, convergence index, proposed connections, keyword matches, experimental ranking and its coding | `data/derived.json`, `data/relations.json` (status `candidate`), `coding` fields, `signals.json` matches |

Analysis is always labelled as such in the interface.

## 2. Entities and definitions

- **Hazard**: a source of potential harm (heatwaves, a virus).
- **Risk**: a hazard combined with exposure and vulnerability; something that may happen and cause harm.
- **Ongoing event**: something already happening that institutions are tracking.
- **Vulnerability**: an underlying weakness that makes harm more likely or larger.
- **Signal**: an early warning or weak signal, not yet an established risk.
- **Assessment**: a published report or statement about any of the above.

Each risk has a stable canonical id (`domain-short-name`). New assessments are added to an existing id rather than creating a new risk. Taxonomy: ten domains (`data/taxonomy.json`); a risk can sit in several, the first is primary.

## 3. Data model and validation

The schema is in `schema/risk.schema.json` and is enforced by `pipeline/analysis.py` (`validate`) in CI. Key rules:

- every assessment has an `https` URL, a publication date at the precision actually known (`2026`, `2026-06` or `2026-06-08`), a method and an independence group;
- `verification` says whether the finding was checked on the institution's own page, its official press release, or through secondary reporting (`via` link);
- quantities keep their original value, unit and definition; there is no conversion between scales;
- missing numbers stay missing. The interface shows **Not quantified**, never a zero or an invented probability;
- quotations are short (max ~30 words) to limit storage of copyrighted text.

## 4. Four ways to look at priority

### A. Institutional attention
Number of **independent** institutions that assessed a risk within a configurable window (default three years). Assessments that derive from the same data or publication share an `independence` group and count once. Labelled attention or convergence, never probability or severity.

### B. Quantified evidence
Published probabilities, counts, losses and similar measures, shown in original units with source, date and method. Values are only comparable when definition, geography and horizon match; Risk Radar does not rank across incompatible measures.

### C. Emerging signals
Risks that are new or newly described (`status: emerging`), plus labelled changes: *New report*, *New risk identified*, *Additional independent assessment*, *Potential cross-sector link*, *Revised assessment*, *Conflicting evidence*. Novelty is shown separately from urgency.

### D. Experimental priority ranking
A transparent multi-criteria comparison (weighted mean) of Risk Radar's own ordinal coding (1 low, 2 medium, 3 high) of:

- impact, likelihood, evidence confidence, and preparedness gap (3 = least prepared).

Users set the weights. A sensitivity check randomly varies every weight by up to ±50% (300 seeded runs) and reports each risk's best and worst rank; a wide range means the position depends mostly on the weighting choice. Risks without coding for a weighted criterion stay **unranked**. The coding is a judgement with a short rationale per risk and can be wrong.

**This score is not an objective measure of danger.** Its references are multi-criteria decision analysis and INFORM's practice of combining hazard and exposure, vulnerability and lack of coping capacity into a documented composite, but Risk Radar's coding is far coarser than INFORM's indicator-based index.

## 5. Convergence index

`0` for a single independent source. Otherwise `min(1, 0.6·(g−1)/3 + 0.4·(m−1)/2)`, with `g` independent institutions and `m` distinct method types in the window. It saturates at four institutions and three methods. It measures how independently different fields arrive at the same problem; it says nothing about how dangerous the problem is.

## 6. Connections

Relationship types: same underlying risk; shared causal driver; potential cascading consequence; common vulnerability or exposure; contradictory or divergent assessment; correlated indicators without established causality.

- **Documented**: a cited source states the link (evidence text and URL stored).
- **Candidate**: proposed by Risk Radar from shared drivers or terms; needs review.

A keyword or semantic match is never treated as causality. Divergence between perception surveys and physical or technical evidence is recorded as a *divergent assessment* so both remain visible.

## 7. The radar

Angle = primary theme. Distance from the centre = the earliest time horizon a source attaches to the risk (≤12 months, 1–5 years, 5–20 years), with a tail for longer horizons. **Distance does not encode severity.** Dot size = independent institutions (attention). Filled = quantified evidence; hollow = qualitative only; dashed amber ring = emerging. A table view gives the same content without the chart.

## 8. Automated updates

`.github/workflows/risk-radar.yml` runs daily and on changes to the pipeline or core data:

1. unit tests (`tests/test_pipeline.py`);
2. validation and derived analysis (`pipeline/analysis.py` → `derived.json`);
3. source checks (`pipeline/ingest.py`):
   - WHO Disease Outbreak News via the official OData API (the RSS addresses return 404);
   - ECDC feeds: threats reports, risk assessments, epidemiological updates;
   - GDACS orange and red alerts;
   - publication pages: IMF GFSR and ENISA publications.
   ReliefWeb (empty RSS response, API needs registration) and weforum.org (refuses automated requests) are curated by hand.
4. commit of changed data files.

Change detection: items are identified by a SHA-1 of their normalised URL (lower-case host, no fragment, no tracking parameters). For publication pages only the set of matching links is hashed, so a changed "last updated" date or cosmetic edits do not create phantom updates. The first successful check of a source is stored as a **baseline** and not announced. A failing source keeps all earlier items and shows its error on the Sources page. `robots.txt` is respected and fetched content is treated as data, never as instructions.

New publications are matched to canonical risks by keyword (`match` terms) and labelled *keywords (unreviewed)*. Promoting a detection to a curated finding (with rating, numbers, quotation) is a manual, cited step.

## 9. Alerts

- In-app: "N new since your last visit", stored only in the visitor's browser.
- Atom feed: `data/feed.xml`, material updates (detected publications after baseline, plus curated signals).
- GitHub: watch the repository to see the daily bot commits.

A static site cannot send push notifications by itself. Publication date and detection date are shown separately.

## 10. Limitations and biases

- The curated set is small and reflects which reports were read, not the whole risk landscape.
- Some findings were verified through secondary reporting; this is marked per assessment.
- Perception surveys (WEF, UN) measure what respondents think, not observed risk.
- Coverage leans towards English-language, European and global institutions.
- ECDC: as of 25 October 2026 the weekly Communicable Disease Threats Report is still published (week 42); the "Public health events" page has no feed.
- INFORM, ACLED and other quantified datasets are registered but not yet ingested (Excel / registered API).
