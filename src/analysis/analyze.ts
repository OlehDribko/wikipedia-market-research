import type { PeriodPlan } from '../periods/plan.ts';
import { ANALYSIS_METHODOLOGY_VERSION, type Analysis, type Comparison, type MetricEntry, type PeriodAnalysis } from '../schemas/analysis.ts';
import type { Warning } from '../schemas/envelope.ts';
import type { Dataset } from '../schemas/research.ts';
import { detectAnomalies } from './anomalies.ts';
import { comparePeriods, comparisonPairs } from './compare.ts';
import { periodMetrics } from './metrics.ts';
import { countedPoints, observationsInPeriod } from './series.ts';
import { analyzeTrend } from './trend.ts';

export const ANALYSIS_LIMITATIONS: readonly string[] = [
  'Trend labels describe the selected period only; they are not forecasts.',
  'Mann–Kendall p-values assume independent observations; pageviews are autocorrelated and seasonal, so p-values are approximate.',
  'Fewer than 12 monthly points cannot separate seasonality from trend.',
  'Spikes are flagged statistically; their causes are unknown and are not inferred.',
  'Inferred zero-view units are included as zeros and remain uncertain.',
  'Cross-language rankings use absolute views; language editions differ in size, so rankings do not measure relative interest.',
];

/** Periods shorter than a year cannot separate a trend from the yearly seasonal cycle. */
export const FULL_YEAR_DAYS = 365;

function periodAnalysis(dataset: Dataset, period: PeriodPlan['periods'][number]): PeriodAnalysis {
  const observations = observationsInPeriod(dataset.observations, period, dataset.granularity);
  const metrics = periodMetrics(observations, period, dataset.granularity);
  const anomalies = detectAnomalies(countedPoints(observations), dataset.granularity);
  const anomalyUnits = new Set(anomalies.anomalies.map((anomaly) => anomaly.period));
  let trend = analyzeTrend(observations, dataset.granularity, metrics.coverage, anomalyUnits);
  const directional = trend.direction === 'increasing' || trend.direction === 'decreasing';
  if (directional && metrics.durationDays < FULL_YEAR_DAYS) trend = { ...trend, issues: [...trend.issues, 'SHORT_SPAN'] };
  return { periodId: period.id, start: period.start, end: period.end, metrics, trend, anomalies };
}

function metricIndex(languages: Analysis['languages'], comparisons: readonly Comparison[]): Record<string, MetricEntry> {
  const index: Record<string, MetricEntry> = {};
  for (const language of languages) {
    for (const period of language.periods) {
      const add = (name: string, value: MetricEntry['value'], unit: MetricEntry['unit']) => {
        index[`${language.lang}.${period.periodId}.${name}`] = { value, unit, lang: language.lang, periodId: period.periodId, comparisonId: null };
      };
      const { metrics, trend, anomalies } = period;
      add('total', metrics.total, 'views');
      add('countedSum', metrics.countedSum, 'views');
      add('averageDaily', metrics.averageDaily, 'views_per_day');
      add('averageMonthly', metrics.averageMonthly, 'views_per_month');
      add('min', metrics.min?.views ?? null, 'views');
      add('max', metrics.max?.views ?? null, 'views');
      add('largestUnitShare', metrics.largestUnitShare, 'ratio');
      add('coverage', metrics.coverage, 'ratio');
      add('durationDays', metrics.durationDays, 'days');
      add('observedUnits', metrics.units.observed, 'count');
      add('inferredZeroUnits', metrics.units.inferredZero, 'count');
      add('missingUnits', metrics.units.missing, 'count');
      add('trend.direction', trend.direction, 'label');
      add('trend.slopeSpanPercentOfMedian', trend.slopeSpanPercentOfMedian, 'percent');
      add('trend.halfMedianChangePercent', trend.halfMedianChangePercent, 'percent');
      add('trend.pValue', trend.mannKendall?.pValue ?? null, 'p_value');
      add('anomalies.count', anomalies.anomalies.length, 'count');
    }
  }
  for (const comparison of comparisons) {
    const add = (name: string, value: MetricEntry['value'], unit: MetricEntry['unit']) => {
      index[`${comparison.lang}.${comparison.id}.${name}`] = { value, unit, lang: comparison.lang, periodId: null, comparisonId: comparison.id };
    };
    add('baselineTotal', comparison.baseline.total, 'views');
    add('currentTotal', comparison.current.total, 'views');
    add('absoluteChange', comparison.absoluteChange, 'views');
    add('percentChange', comparison.percentChange, 'percent');
    add('baselineAverageDaily', comparison.baseline.averageDaily, 'views_per_day');
    add('currentAverageDaily', comparison.current.averageDaily, 'views_per_day');
    add('averageDailyChange', comparison.averageDailyChange, 'views_per_day');
    add('averageDailyPercentChange', comparison.averageDailyPercentChange, 'percent');
    add('status', comparison.status, 'label');
  }
  return index;
}

const COMPARISON_MESSAGES: Partial<Record<Comparison['issues'][number], string>> = {
  UNEQUAL_DURATION: 'The periods have different lengths; compare average daily views, not totals, for interest intensity.',
  SEASONALITY_NOT_ALIGNED: 'The periods cover different parts of the year; seasonal patterns can explain part of the difference.',
  PERIODS_OVERLAP: 'The periods overlap, so they share observations.',
};

function analysisWarnings(languages: Analysis['languages'], comparisons: readonly Comparison[]): Warning[] {
  const warnings: Warning[] = [];
  for (const language of languages) {
    for (const period of language.periods) {
      const where = `${language.lang}, period ${period.periodId}`;
      const { nullReasons, units } = period.metrics;
      if (nullReasons.total && nullReasons.total !== 'PERIOD_INCOMPLETE') {
        warnings.push({
          code: 'TOTAL_NOT_CALCULATED',
          message:
            nullReasons.total === 'NO_DATA'
              ? `Total views are not calculated (${where}): no unit in the period can hold data (e.g. the article did not exist yet).`
              : `Total views are not calculated (${where}): ${units.missing} of ${units.expected} expected units have no data. countedSum is a lower bound.`,
          language: language.lang,
        });
      }
      if (nullReasons.total === 'PERIOD_INCOMPLETE') {
        warnings.push({ code: 'TOTAL_NOT_CALCULATED', message: `Total views are not calculated (${where}): the period is not complete yet.`, language: language.lang });
      }
      if (nullReasons.averageDaily === 'INSUFFICIENT_COVERAGE') {
        warnings.push({ code: 'AVERAGE_NOT_CALCULATED', message: `Averages are not calculated (${where}): coverage ${period.metrics.coverage} is below 0.9.`, language: language.lang });
      }
      if (period.anomalies.anomalies.length > 0) {
        const top = [...period.anomalies.anomalies].sort((a, b) => b.views - a.views)[0];
        warnings.push({
          code: 'SPIKES_DETECTED',
          message: `${period.anomalies.anomalies.length} unusual spike(s) (${where}); largest on ${top?.period} with ${top?.views} views. Causes are unknown.`,
          language: language.lang,
        });
      }
      if (period.trend.issues.includes('SHORT_SPAN')) {
        warnings.push({
          code: 'TREND_MAY_BE_SEASONAL',
          message: `The ${period.trend.direction} trend (${where}) covers ${period.metrics.durationDays} days, less than a year; it may reflect a seasonal pattern rather than lasting change.`,
          language: language.lang,
        });
      }
      if (period.trend.issues.includes('SPIKE_DRIVEN')) {
        warnings.push({ code: 'TREND_DRIVEN_BY_SPIKES', message: `The apparent trend (${where}) depends on a few spikes and is reported as no_clear_trend.`, language: language.lang });
      }
    }
  }
  for (const comparison of comparisons) {
    for (const issue of comparison.issues) {
      const message = COMPARISON_MESSAGES[issue];
      const lengths = issue === 'UNEQUAL_DURATION' ? ` (${comparison.baseline.durationDays} vs ${comparison.current.durationDays} days)` : '';
      if (message) warnings.push({ code: issue === 'UNEQUAL_DURATION' ? 'UNEQUAL_PERIOD_LENGTH' : issue, message: `${comparison.id}${lengths}: ${message}` });
    }
    if (comparison.issues.includes('BASELINE_ZERO')) {
      warnings.push({ code: 'BASELINE_ZERO', message: `${comparison.id}: the baseline is zero, so percentage change is undefined.`, language: comparison.lang });
    }
    if (comparison.status === 'insufficient_data') {
      warnings.push({ code: 'COMPARISON_NOT_POSSIBLE', message: `${comparison.id}: not enough data to compare (${comparison.lang}).`, language: comparison.lang });
    }
  }
  return warnings;
}

/** Deterministic analysis of collected datasets. Pure: same datasets and plan → same result. */
export function analyzeResearch(datasets: readonly Dataset[], plan: Pick<PeriodPlan, 'periods'>): { analysis: Analysis; warnings: Warning[] } {
  const languages: Analysis['languages'] = datasets.map((dataset) => ({
    lang: dataset.lang,
    title: dataset.title,
    url: dataset.url,
    wikidataId: dataset.wikidataId,
    periods: plan.periods.map((period) => periodAnalysis(dataset, period)),
  }));

  const comparisons: Comparison[] = [];
  for (const pair of comparisonPairs(plan.periods)) {
    for (const language of languages) {
      const baseline = language.periods.find((period) => period.periodId === pair[0].id) as PeriodAnalysis;
      const current = language.periods.find((period) => period.periodId === pair[1].id) as PeriodAnalysis;
      comparisons.push(comparePeriods(language.lang, baseline, current, pair));
    }
  }

  const crossLanguage = plan.periods.map((period) => ({
    periodId: period.id,
    ranking: languages
      .map((language) => {
        const analysis = language.periods.find((candidate) => candidate.periodId === period.id) as PeriodAnalysis;
        return { lang: language.lang, title: language.title, averageDaily: analysis.metrics.averageDaily, total: analysis.metrics.total, trend: analysis.trend.direction };
      })
      .sort((a, b) => (b.averageDaily ?? -1) - (a.averageDaily ?? -1) || a.lang.localeCompare(b.lang)),
  }));

  const analysis: Analysis = {
    methodologyVersion: ANALYSIS_METHODOLOGY_VERSION,
    methodology: 'references/METHODOLOGY.md',
    languages,
    comparisons,
    crossLanguage,
    metrics: metricIndex(languages, comparisons),
    limitations: [...ANALYSIS_LIMITATIONS],
  };
  return { analysis, warnings: analysisWarnings(languages, comparisons) };
}
