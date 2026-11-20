# NList

How the Netherlands compares in country rankings. Live at https://mvanpassel-cmyk.github.io/nlist/

- `charts.json` — the list of charts (OWID grapher slug, theme, title, unit) and a `theme_log` of monthly additions.
- `scripts/build.py` — downloads every chart from Our World in Data and writes `data.json` (latest value per country since 2014, EU + world selection shown, Dutch rank against all countries).
- `index.html` — the page; it reads `data.json`.

## Monthly update

1. Pick a theme not yet in `theme_log`.
2. Find 5–15 suitable OWID charts (one value per country per year, recent Dutch data, no absolute totals that just measure country size) and test them: `python3 scripts/build.py --check slug1 slug2 ...`
3. Add the ones that pass to `charts.json` (use an existing theme name for `cat`), append the theme to `theme_log`.
4. `python3 scripts/build.py` to refresh all data, commit and push.

Data: Our World in Data (CC BY) and the original sources named on each chart.
