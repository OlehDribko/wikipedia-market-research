# Example: Astronomy, Ukrainian and Polish Wikipedia, 2024 vs 2025

Real Wikimedia data, collected on 2026-09-25 with:

```bash
node scripts/wmr.ts research --article en:Astronomy --langs uk,pl --compare 2024-01..2024-12,2025-01..2025-12
node scripts/wmr.ts report --research research.json --conclusions conclusions-uk.json --out report-uk.pdf
node scripts/wmr.ts report --research research.json --conclusions conclusions-pl.json --out report-pl.pdf
```

- `research.json`: the complete research file, with all observations, the analysis and the metric index.
- `conclusions-*.json`: example conclusions of the kind an AI agent writes. Every number is backed by a cited metric.
- `report-*.pdf` and `report-*-chart.svg`: the generated one-page reports and charts.
