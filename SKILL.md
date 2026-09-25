---
name: wikipedia-market-research
description: Analyzes Wikipedia pageview statistics for a topic across language editions and time periods to gauge audience interest for B2C product research. Resolves the topic to verified Wikipedia articles, compares periods and languages, runs deterministic trend statistics with data-quality checks, and produces a chart and one-page PDF report. Use when the user asks about interest in a topic, market or product idea, Wikipedia pageviews, attention trends, or comparing interest between languages or periods.
license: MIT
compatibility: Requires Node.js >= 24 and npm, plus internet access to Wikimedia APIs (wikipedia.org, wikimedia.org).
metadata:
  version: "0.1.0"
  repository: https://github.com/OlehDribko/wikipedia-market-research
---

# Wikipedia Market Research

> **Development status (v0.1.0):** `resolve`, `research` (including statistics) and `report` work.

## Setup

Run once in the skill directory:

```bash
npm ci --omit=dev
```

Optional: set `WMR_CONTACT` (URL or email) to identify yourself to Wikimedia. See `.env.example`.

## Commands

All commands run from the skill directory and print one JSON object to stdout.
Check `ok`. On failure, read `error.code`, `error.message` and `error.hint`, then act on the hint.

| Command | Purpose |
|---|---|
| `node scripts/wmr.ts research ...` | Main command: resolve articles, fetch pageviews, analyze. Saves the full result file and prints a compact summary. |
| `node scripts/wmr.ts resolve ...` | List candidate articles when a topic is ambiguous. |
| `node scripts/wmr.ts report ...` | Build the PDF from a saved research file and your conclusions. Makes no API calls. |

Run `node scripts/wmr.ts <command> --help` for all options and examples.

## Resolving topics

`resolve` returns `data.status`:

- `resolved`: `data.source` is the verified source article. `data.articles` lists one entry per requested
  language, each with its own `status`. Only `verified` entries are usable. Report every language in
  `data.missingLanguages` as unavailable. Never replace it with a translated title or a search result.
- `ambiguous`: `data.candidates` lists possible articles. Ask the user which one they mean, then run
  `resolve` again with `--topic` set to that candidate's exact `title`.
- `not_found`: ask the user to rephrase the topic or name another source language.

Always follow `data.nextStep`. Article titles must come from CLI output. Never invent titles or assume
that a translated title exists. If a redirect warning shows the article is broader than the user's topic
(`REDIRECT_FOLLOWED`, `REDIRECT_TO_SECTION`), tell the user.

## Workflow

1. **Clarify the topic.** If the topic could mean several things (e.g. "Mercury"), run `resolve` and
   ask the user which article they mean, or choose only when the context makes it unambiguous.
2. **Choose languages.** `--langs` is required. Take the languages from the user's request or the
   conversation. If you cannot tell which languages they mean, **ask the user**. Never choose languages arbitrarily.
3. **Choose the period.** Use the user's dates:
   - A single range: pass `--start` and `--end`.
   - Periods to compare: pass `--compare`. Only those periods are analyzed.
   - No period at all: omit these flags. The CLI uses the **last 12 completed calendar months**.
     Tell the user you assumed this.
4. **Run `research`.** Read `warnings` and each language's data quality before interpreting anything.
   - Only `observed` values are measured.
   - `zero_omitted` values are uncertain zeros.
   - `unavailable`, `before_creation`, `incomplete` and `api_error` have no value. Never treat them as zero.
   - If the command fails with `AMBIGUOUS_TOPIC`, show `error.details.candidates` to the user and retry with
     `--article LANG:Title`.
5. **Interpret** `data.analysis` (see "Reading results"). Do not compute or invent new statistics.
6. **Report (optional).** Write a conclusions file in the user's language, then run `report` (see "Writing a report").
7. **Follow-ups.** For changed parameters (languages, dates, comparisons), run `research` again with
   the new flags. Cached data is reused automatically.

## Reading results

`research` prints a compact `data.analysis`. The full result, with every observation and all details, is saved at
`data.artifactPath`.

- **`periods[]`:** per language and period:
  - `total` (null if any data is missing or the period is incomplete)
  - `averageDaily`, `averageMonthly`, `coverage`
  - `trend`, `trendPValue`, `trendSlopeSpanPercentOfMedian`
  - `spikes`, `largestUnitShare`
- **`comparisons[]`:** `percentChange` (totals) and `averageDailyPercentChange` (intensity).
  - Lead with the measure named in `primaryMeasure`. With unequal period lengths, only daily averages show changes
    in interest intensity.
  - `status` and `issues` say how reliable the comparison is.
- **Trend labels:**
  - `increasing` / `decreasing`: a consistent, statistically supported tendency within the period.
  - `stable`: small change without large swings.
  - `no_clear_trend`: movement without a consistent direction.
  - `insufficient_data`: too little data to judge.
- **`trendSlopeSpanPercentOfMedian`** is a slope relative to the median level, **not** a percentage change in views.
  Never phrase it as "views grew by X %".
- **Spikes:** `topSpikes` lists unusual peaks. Their causes are unknown; do not speculate. They stay included in all
  totals.
- **Nulls:** a null metric means it could not be calculated reliably. Say so; never estimate it.
- **Citing:** cite numbers by metric ID following `metricIdPattern` (e.g. `uk.main.averageDaily`).

Definitions, thresholds and limitations: [references/METHODOLOGY.md](references/METHODOLOGY.md).

## Writing a report

`report` turns a saved research file into a one-page PDF and an SVG chart. It makes no API calls and changes nothing
in the research file. You only write a JSON file. All layout, charts, fonts and number formatting are handled by the CLI.

```bash
node scripts/wmr.ts report --research <data.artifactPath> --conclusions conclusions.json [--out report.pdf]
```

```json
{
  "language": "uk",
  "headline": "One sentence, no statistics",
  "findings": [
    { "statement": "Перегляди за день впали на 59,74 %.", "evidence": ["uk.compare-1_vs_compare-2.averageDailyPercentChange"] }
  ],
  "hypotheses": [{ "hypothesis": "…", "validationIdea": "…" }],
  "limitations": ["…"]
}
```

Rules, checked by the CLI:

- **`language`:** the user's language. It sets the report language. Built-in labels exist for `uk`, `pl` and `en`;
  other languages use English headings unless you add `labels`.
- **`findings`:** 1–8 findings. Each cites metric IDs that exist in the research file (see `metricIdPattern`).
- **Numbers:**
  - A number in a finding must equal a value of a metric that finding cites. Rounding is allowed, e.g. 59,7 or 60
    for −59,74. Any locale format works.
  - The headline, hypotheses and limitations may mention only years, period lengths and counts; put statistics in
    findings.
  - `validationIdea` may contain planning numbers.
- **Characters:** no emoji or scripts outside Latin, Cyrillic and Greek; the font cannot render them.
- **Fixed content:** the metric tables, the chart, the standard limitations and the data-quality summary always
  come from the research file. You cannot change them.
- **Errors:**
  - `INVALID_CONCLUSIONS`: fix each item in `error.details.issues` (unknown IDs come with `suggestions`) and run
    again.
  - `REPORT_DOES_NOT_FIT`: shorten your text. Nothing is truncated automatically.

## Interpretation rules

- Pageviews are **not** unique people, visitors or customers.
- A Wikipedia language edition is **not** a country.
- Absolute views are not directly comparable across language editions (edition sizes differ).
- Use only numbers from CLI output. Every finding in a report must cite metric IDs from the research file.
- Treat trends marked `insufficient_data` as undetermined. You may still report the factual totals.
- Say "statistically significant" only for p < 0.05, and note that p-values are approximate for pageview data.
- A trend over less than a year (`TREND_MAY_BE_SEASONAL`) may be seasonal. Say so.
- Cross-language rankings compare absolute views, not relative interest.
- Always tell the user about data-quality warnings and uncertain statuses.
- No forecasts: describe what happened in completed periods only.
