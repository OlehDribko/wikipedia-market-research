import { enumerateDays, type DateRange } from '../periods/dates.ts';
import type { FetchGranularity } from '../periods/plan.ts';
import type { NullReason, PeriodMetrics } from '../schemas/analysis.ts';
import type { Observation } from '../schemas/observation.ts';
import { countedPoints, daysInUnit, type CountedPoint } from './series.ts';
import { round, sum } from './stats.ts';

/** Averages need at least this share of expected units to be counted. */
export const MIN_AVERAGE_COVERAGE = 0.9;

function extreme(points: readonly CountedPoint[], pick: (a: number, b: number) => boolean): PeriodMetrics['min'] {
  let best: CountedPoint | undefined;
  for (const point of points) if (!best || pick(point.views, best.views)) best = point;
  return best ? { period: best.period, views: best.views, inferred: best.inferred } : null;
}

/**
 * Basic metrics for one period of one language. `observations` are the period's units (all statuses).
 * - total: only when every expected unit is counted and no unit is incomplete; otherwise null + reason.
 * - averageDaily: counted views / days covered by counted units, when coverage ≥ 90 %.
 * - averageMonthly: counted views / counted months (monthly data only), when coverage ≥ 90 %.
 * Inferred zero-view units count as 0 and are reported separately.
 */
export function periodMetrics(observations: readonly Observation[], period: DateRange, granularity: FetchGranularity): PeriodMetrics {
  const count = (status: Observation['status']) => observations.filter((observation) => observation.status === status).length;
  const units = {
    total: observations.length,
    expected: observations.length - count('before_creation') - count('incomplete'),
    counted: count('observed') + count('zero_omitted'),
    observed: count('observed'),
    inferredZero: count('zero_omitted'),
    missing: count('unavailable') + count('api_error'),
    incomplete: count('incomplete'),
    beforeCreation: count('before_creation'),
  };
  const coverage = units.expected > 0 ? units.counted / units.expected : null;
  const points = countedPoints(observations);
  const countedSum = sum(points.map((point) => point.views));
  const countedDays = sum(points.map((point) => daysInUnit(point.period, granularity)));
  const nullReasons: Record<string, NullReason> = {};

  let total: number | null = null;
  if (units.incomplete > 0) nullReasons.total = 'PERIOD_INCOMPLETE';
  else if (units.expected === 0) nullReasons.total = 'NO_DATA';
  else if (units.counted < units.expected) nullReasons.total = 'MISSING_UNITS';
  else total = countedSum;

  const averagesAllowed = units.counted > 0 && coverage !== null && coverage >= MIN_AVERAGE_COVERAGE;
  const averageReason: NullReason = units.counted === 0 ? 'NO_DATA' : 'INSUFFICIENT_COVERAGE';

  let averageDaily: number | null = null;
  if (averagesAllowed) averageDaily = round(countedSum / countedDays, 2);
  else nullReasons.averageDaily = averageReason;

  let averageMonthly: number | null = null;
  if (granularity === 'daily') nullReasons.averageMonthly = 'DAILY_GRANULARITY';
  else if (averagesAllowed) averageMonthly = round(countedSum / units.counted, 2);
  else nullReasons.averageMonthly = averageReason;

  const max = extreme(points, (a, b) => a > b);
  return {
    durationDays: enumerateDays(period).length,
    units,
    coverage: coverage === null ? null : round(coverage, 4),
    total,
    countedSum,
    countedDays,
    averageDaily,
    averageMonthly,
    min: extreme(points, (a, b) => a < b),
    max,
    largestUnitShare: max && countedSum > 0 ? round(max.views / countedSum, 4) : null,
    nullReasons,
  };
}
