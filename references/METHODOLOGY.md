# Methodology

How `research` turns Wikipedia pageviews into indicators. All calculations are deterministic TypeScript
(`src/analysis/`). The agent interprets these numbers; it must not compute its own statistics.

Methodology version: **1** (`analysis.methodologyVersion`).

## 1. Data and units

- **Source:** Wikimedia per-article pageviews with `agent=user` and `access=all-access`. One verified article per
  language edition.
- **Units:** a *unit* is one day (daily data) or one calendar month (monthly data).
  - `auto` granularity picks monthly when every period covers whole calendar months, otherwise daily.
- **Status:** every unit has a status (see §6). *Counted* units are `observed` plus `zero_omitted`.
  `zero_omitted` is an inferred zero and stays marked as uncertain.
- **Periods:** `main` (from `--start`/`--end`, or the default of the last 12 completed months) and `compare-1`,
  `compare-2`, …, in the order the user gave them.

## 2. Period metrics (`analysis.languages[].periods[].metrics`)

| Metric | Definition | Null when (`nullReasons`) |
|---|---|---|
| `durationDays` | Calendar days in the period, inclusive | never |
| `units.*` | Counts per status; `expected` = all units except `before_creation` and `incomplete` | never |
| `coverage` | counted / expected | nothing expected |
| `total` | Sum of counted units | any expected unit missing (`MISSING_UNITS`), any unit incomplete (`PERIOD_INCOMPLETE`), nothing expected (`NO_DATA`) |
| `countedSum` | Sum of counted units | never; a lower bound when units are missing |
| `countedDays` | Days represented by counted units | never |
| `averageDaily` | countedSum / countedDays | coverage < 0.9 (`INSUFFICIENT_COVERAGE`), nothing counted (`NO_DATA`) |
| `averageMonthly` | countedSum / counted months | daily data (`DAILY_GRANULARITY`), or the same cases as `averageDaily` |
| `min`, `max` | Smallest and largest counted unit; `inferred: true` marks an inferred zero | nothing counted |
| `largestUnitShare` | max / countedSum: how concentrated views are in one unit | countedSum = 0 |

Notes:

- **Lifetime days only.** Units before the article's creation are excluded from `expected` and from `averageDaily`,
  so the average covers the days the article existed.
- **Incomplete periods.** A period reaching today or later has no `total`, because the period is not over.
  Its `averageDaily` covers the completed days only.
- **Rounding.** Stored averages are rounded to 2 decimals, but comparisons use unrounded values.

## 3. Period comparisons (`analysis.comparisons`)

- **Pairs.** Consecutive `--compare` periods in the user's order: `compare-1` → `compare-2`, then
  `compare-2` → `compare-3`. The first period of each pair is the baseline.
- **Change in totals:**
  - `absoluteChange = current.total − baseline.total`
  - `percentChange = absoluteChange / baseline.total × 100`
- **Change in intensity:** `averageDailyChange` and `averageDailyPercentChange` are the same calculation on
  average daily views.
- **Zero baseline:** percentages are `null` with `BASELINE_ZERO`. The absolute change is still reported.
- **Primary measure (`primaryMeasure`):**
  - `total` only when both periods have the same length and both totals exist.
  - Otherwise `averageDaily`, because a longer period collects more views without any change in interest.
- **Status:** `insufficient_data` when no primary measure exists, `comparable_with_limitations` when any issue
  applies, and `comparable` otherwise.

**Comparison issues:**

| Issue | Meaning |
|---|---|
| `UNEQUAL_DURATION` | Different lengths, including leap years; compare `averageDaily` |
| `SEASONALITY_NOT_ALIGNED` | Not the same calendar position in different years; seasonality may explain the difference |
| `PERIODS_OVERLAP` | The periods share days |
| `PERIOD_INCOMPLETE`, `MISSING_UNITS`, `INSUFFICIENT_COVERAGE` | Data gaps in either period |
| `BEFORE_CREATION` | The article did not exist for part of a period |
| `INFERRED_ZEROS` | Inferred zero-view units are included |
| `SPIKES_PRESENT` | Flagged spikes in either period; see §5 |

## 4. Trend (`periods[].trend`)

**Series.**
- Monthly data uses the monthly values.
- Daily data uses **consecutive 7-day blocks** from the period start. This removes the weekday cycle and reduces
  autocorrelation. A block is used only if all 7 days are counted, and a trailing partial block is dropped
  (`droppedBlocks`).

**Measures:**
- **Mann–Kendall test** for a monotonic trend, two-sided:
  - exact null distribution for n ≤ 30 without ties
  - otherwise the normal approximation with tie-corrected variance and continuity correction
- **Theil–Sen slope** (median of pairwise slopes, robust to outliers). `slopeSpanPercentOfMedian` = slope ×
  (points − 1) / median × 100. This is how far the fitted line moves over the span relative to a typical point.
  **It is not a percentage change of views**, and values beyond ±100 % are possible.
- **Half-median change:** median of the second half vs the first half, in %.
- **Robust CV:** 1.4826 × MAD / median, a measure of dispersion.

**Classification** (first match wins):

1. **`insufficient_data`**:
   - coverage < 0.9
   - fewer than 6 months or 8 complete 7-day blocks (56 days)
   - a median level of 0
2. **`increasing` / `decreasing`**: all of these hold:
   - Mann–Kendall p < 0.05
   - |`slopeSpanPercentOfMedian`| ≥ 10
   - the half-median change has the same sign and |change| ≥ 10 %
   - the result survives removing flagged spikes (§5): the Mann–Kendall test is re-run without those units and must
     still give p < 0.05 in the same direction
3. **`stable`**:
   - |`slopeSpanPercentOfMedian`| < 10
   - |half-median change| < 10 %
   - robust CV ≤ 0.5
4. **`no_clear_trend`**: everything else.

**Trend issues:**

| Issue | Meaning |
|---|---|
| `SPIKE_DRIVEN` | The trend disappears without spikes |
| `HALVES_DISAGREE` | Significant and large, but the half-medians don't support it |
| `HIGH_VARIABILITY` | Small net change but large swings (e.g. V-shape) |
| `INFERRED_ZEROS` | Inferred zeros are in the series |
| `SHORT_SPAN` | A directional trend over less than 365 days; it may be seasonal (`TREND_MAY_BE_SEASONAL` warning) |

**Interpretation limits:**
- A p-value is reported as `mannKendall.pValue`. "Statistically significant" may be said only for p < 0.05, and only
  with the caveat that pageviews are autocorrelated and seasonal, which violates the test's independence
  assumption. Treat p-values as approximate.
- Percentage change between two points never determines a trend.
- Trend labels describe the selected period, not the future.

## 5. Spikes (`periods[].anomalies`)

**Rolling median/MAD rule.** For each counted unit, the baseline is made of its neighbouring counted units, excluding
the unit itself: up to 14 on each side for days, and up to 6 for months.

- `spread = max(1.4826 × MAD, 0.1 × median, 1)`
- `threshold = median + 5 × spread`

A unit is flagged when **views > threshold** and **views ≥ 2 × median**. Only upward spikes are flagged.

**Minimum data.** At least 14 neighbours (daily) or 5 (monthly) are needed. Otherwise `checked: false`, with a
reason.

**Output per spike:**
- period and views
- `baselineMedian`, `baselineSpread` and `threshold`
- `ratioToBaseline` (null for a zero baseline)
- `shareOfCountedSum`
- `reason`

**Spikes stay in the data.** They are never removed from totals or averages. `countedSumExcludingAnomalies` shows
their weight. The cause of a spike is unknown and must not be guessed.

## 6. Data quality

| Status | In calculations | Certainty |
|---|---|---|
| `observed` | Its value (explicit `views: 0` rows are observed zeros) | established |
| `zero_omitted` | Counted as 0 | uncertain: omitted units had no recorded traffic of any kind |
| `unavailable`, `api_error` | Missing; blocks `total`; lowers coverage | per unit |
| `incomplete` | Excluded; blocks `total` | established |
| `before_creation` | Excluded from expected units | established |

No numerical confidence scores are produced. Reliability is expressed through `nullReasons`, `issues`, `coverage`,
`status` and warnings.

## 7. Cross-language comparison

- **Separate per edition.** Every language is analyzed separately (`analysis.languages[]`), keeping its code,
  verified title, URL and Wikidata ID.
- **Ranking.** `analysis.crossLanguage` ranks editions by **absolute** average daily views.
- **No normalization.** Editions differ greatly in size and no normalization is applied, so a ranking shows where
  more views happened. It doesn't show where interest is relatively higher.
- **Not audiences or markets.** Never convert pageviews into people, customers or countries.

## 8. Metric IDs

Every important number is indexed in `analysis.metrics` under a stable ID with its unit.

- **Period metrics** use `<lang>.<periodId>.<metric>`, with these metric names:
  - `total`, `countedSum`, `averageDaily`, `averageMonthly`
  - `min`, `max`, `largestUnitShare`
  - `coverage`, `durationDays`, `observedUnits`, `inferredZeroUnits`, `missingUnits`
  - `trend.direction`, `trend.slopeSpanPercentOfMedian`, `trend.halfMedianChangePercent`, `trend.pValue`
  - `anomalies.count`
- **Comparison metrics** use `<lang>.<baselineId>_vs_<currentId>.<metric>`, with these metric names:
  - `baselineTotal`, `currentTotal`, `absoluteChange`, `percentChange`
  - `baselineAverageDaily`, `currentAverageDaily`, `averageDailyChange`, `averageDailyPercentChange`
  - `status`

Examples: `uk.main.averageDaily` and `pl.compare-1_vs_compare-2.averageDailyPercentChange`.
Report findings must cite these IDs.
