# Pledge & Practice

Implementation tracker for the Dutch Global Health Strategy 2023–2030
("Samen zorgen voor gezondheid wereldwijd"). Live: https://mvanpassel-cmyk.github.io/pledge-and-practice/

Single page (`index.html`) that renders everything from `data.json`. No build step.
Uses `../nphi-map/lib/d3.min.js`, `topojson-client.min.js` and `countries-110m.json` for the map.

## data.json

| key | what |
|---|---|
| `meta` | title, strategy period, `updated`, `nextUpdate` (YYYY-MM-DD) |
| `statuses` | rating scale: delivered, on-track, partial, fading, no-evidence |
| `priorities` | P1–P3 and G (governance) with spearheads (P1a … G3) |
| `commitments` | the pledges: `id`, `sp` (spearhead), `role` (Connector/Innovator/Champion), `status`, `pledge`, `assessment`, `evidence[]` = `{src, text, neg?}` (`neg: true` = checked, not mentioned; does not light the report dot) |
| `emerging` | lines of work not in the 2022 text |
| `sources` | labels for S, R1, R2, R3 |
| `reports` | the progress letters (date, ref, ministers, url) — add R4 etc. here and in `sources` |
| `pulse` | keyword mentions per document (`docs.S/R1/R2/R3`: words, counts, per1000) |
| `money.series` | budget article 3.1: `realised`, `planned`, `ambition`, `topups` |
| `money.ledger` | named euro commitments (`eur` in € million, `yearly: true` = per year) |
| `risks` | RIVM risk scan 2026 top 15 with coverage `strong` / `partial` / `gap` |
| `partners` | countries named in the reports (`country` as world-atlas name, except `DR Congo`, `Palau` handled in JS) |
| `parliament` | motions and commitments; `status` done / done-late / partial / ongoing / open |
| `timeline` | dated events; `kind` policy, eu, event, milestone, evaluation, report, parliament, money, future; `approx: "year"` hides the month |
| `indicators` | suggested indicator set with public data sources |
| `observations` | reading notes, each with `src[]` |
| `library` | every source document (`id` is what `src` fields refer to) |
| `changelog` | one line per monthly update |

Every `src` must be a `library` id or S/R1/R2/R3. Texts are English summaries in our own words;
document titles stay in Dutch.

## Monthly update

Once a month: look for new Kamerstukken, debates, motions, commitments, budget letters, EU documents,
evaluations and RIVM/IOB/AIV reports on global health and the strategy; add them to `library`,
attach evidence to the right pledges, change a status only when a document supports it, update
`parliament`, `timeline`, `money`, `meta.updated`, `meta.nextUpdate` and add a `changelog` line.
When a new progress report appears, add it as R4 in `sources`, `reports` and `pulse` (the page picks it up automatically).
