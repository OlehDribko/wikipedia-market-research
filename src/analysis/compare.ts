import type { PlannedPeriod } from '../periods/plan.ts';
import type { Comparison, ComparisonIssue, NullReason, PeriodAnalysis } from '../schemas/analysis.ts';
import { percentChange, round } from './stats.ts';

/** Consecutive pairs of --compare periods in the user's order: compare-1 → compare-2, compare-2 → compare-3, … */
export function comparisonPairs(periods: readonly PlannedPeriod[]): [PlannedPeriod, PlannedPeriod][] {
  const compared = periods.filter((period) => period.id.startsWith('compare-'));
  return compared.slice(1).map((current, index) => [compared[index] as PlannedPeriod, current]);
}

export function comparisonId(baseline: PlannedPeriod, current: PlannedPeriod): string {
  return `${baseline.id}_vs_${current.id}`;
}

/** Same calendar position in different years (e.g. Jan–Jun 2024 vs Jan–Jun 2025). */
function seasonallyAligned(a: PlannedPeriod, b: PlannedPeriod): boolean {
  return a.start.slice(5) === b.start.slice(5) && a.end.slice(5) === b.end.slice(5) && a.start.slice(0, 4) !== b.start.slice(0, 4);
}

function overlap(a: PlannedPeriod, b: PlannedPeriod): boolean {
  return a.start <= b.end && b.start <= a.end;
}

function side(period: PeriodAnalysis) {
  return {
    periodId: period.periodId,
    start: period.start,
    end: period.end,
    durationDays: period.metrics.durationDays,
    total: period.metrics.total,
    averageDaily: period.metrics.averageDaily,
    coverage: period.metrics.coverage,
  };
}

/**
 * Compares two periods of one language.
 * - Totals change only when both totals exist; with unequal durations the average daily change leads.
 * - Percentage changes from a zero baseline are null (BASELINE_ZERO), never infinite.
 */
export function comparePeriods(lang: string, baseline: PeriodAnalysis, current: PeriodAnalysis, periods: [PlannedPeriod, PlannedPeriod]): Comparison {
  const issues = new Set<ComparisonIssue>();
  const nullReasons: Record<string, NullReason> = {};
  const [basePeriod, currentPeriod] = periods;
  const equalDuration = baseline.metrics.durationDays === current.metrics.durationDays;

  if (!equalDuration) issues.add('UNEQUAL_DURATION');
  if (!seasonallyAligned(basePeriod, currentPeriod)) issues.add('SEASONALITY_NOT_ALIGNED');
  if (overlap(basePeriod, currentPeriod)) issues.add('PERIODS_OVERLAP');
  for (const period of [baseline, current]) {
    const { units, nullReasons: reasons } = period.metrics;
    if (units.incomplete > 0) issues.add('PERIOD_INCOMPLETE');
    if (units.missing > 0) issues.add('MISSING_UNITS');
    if (reasons.averageDaily === 'INSUFFICIENT_COVERAGE') issues.add('INSUFFICIENT_COVERAGE');
    if (units.beforeCreation > 0) issues.add('BEFORE_CREATION');
    if (units.inferredZero > 0) issues.add('INFERRED_ZEROS');
    if (period.anomalies.anomalies.length > 0) issues.add('SPIKES_PRESENT');
  }

  let absoluteChange: number | null = null;
  let percent: number | null = null;
  const baseTotal = baseline.metrics.total;
  const currentTotal = current.metrics.total;
  if (baseTotal === null || currentTotal === null) {
    nullReasons.absoluteChange = (baseTotal === null ? baseline : current).metrics.nullReasons.total ?? 'NO_DATA';
    nullReasons.percentChange = nullReasons.absoluteChange;
  } else {
    absoluteChange = currentTotal - baseTotal;
    percent = percentChange(baseTotal, currentTotal);
    if (percent === null) {
      nullReasons.percentChange = 'BASELINE_ZERO';
      issues.add('BASELINE_ZERO');
    }
  }

  let averageDailyChange: number | null = null;
  let averageDailyPercent: number | null = null;
  // Changes use unrounded averages; only the stored averages are rounded for display.
  const exactAverage = (period: PeriodAnalysis) =>
    period.metrics.averageDaily === null ? null : period.metrics.countedSum / period.metrics.countedDays;
  const baseAverage = exactAverage(baseline);
  const currentAverage = exactAverage(current);
  if (baseAverage === null || currentAverage === null) {
    nullReasons.averageDailyChange = (baseAverage === null ? baseline : current).metrics.nullReasons.averageDaily ?? 'NO_DATA';
    nullReasons.averageDailyPercentChange = nullReasons.averageDailyChange;
  } else {
    averageDailyChange = currentAverage - baseAverage;
    averageDailyPercent = percentChange(baseAverage, currentAverage);
    if (averageDailyPercent === null) {
      nullReasons.averageDailyPercentChange = 'BASELINE_ZERO';
      issues.add('BASELINE_ZERO');
    }
  }

  const primaryMeasure = percent !== null && equalDuration ? 'total' : averageDailyPercent !== null ? 'averageDaily' : null;
  const status = primaryMeasure === null ? 'insufficient_data' : issues.size > 0 ? 'comparable_with_limitations' : 'comparable';

  return {
    id: comparisonId(basePeriod, currentPeriod),
    lang,
    baseline: side(baseline),
    current: side(current),
    absoluteChange,
    percentChange: percent === null ? null : round(percent, 2),
    averageDailyChange: averageDailyChange === null ? null : round(averageDailyChange, 2),
    averageDailyPercentChange: averageDailyPercent === null ? null : round(averageDailyPercent, 2),
    equalDuration,
    primaryMeasure,
    status,
    issues: [...issues],
    nullReasons,
  };
}
