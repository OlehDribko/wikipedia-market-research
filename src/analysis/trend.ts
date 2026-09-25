import type { FetchGranularity } from '../periods/plan.ts';
import type { Trend } from '../schemas/analysis.ts';
import type { Observation } from '../schemas/observation.ts';
import { countedPoints, weeklyBlocks } from './series.ts';
import { mad, mannKendall, median, percentChange, round, theilSenSlope } from './stats.ts';

/** Documented in references/METHODOLOGY.md. */
export const TREND_RULES = {
  /** Significance level of the two-sided Mann–Kendall test. */
  alpha: 0.05,
  /** Minimum |relative change| over the period for a direction (and the "stable" band). */
  minSlopeSpanPercent: 10,
  /** Minimum points: 6 months, or 8 complete 7-day blocks (56 days) of daily data. */
  minPoints: { monthly: 6, weekly_blocks: 8 },
  minCoverage: 0.9,
  /** "stable" also requires a robust coefficient of variation (1.4826 × MAD / median) at or below this. */
  maxStableRobustCv: 0.5,
} as const;

type Issue = Trend['issues'][number];

interface SeriesPoint {
  key: string;
  views: number;
  inferred: number;
  /** Underlying units, used to drop spikes for the robustness check. */
  units: string[];
}

function sign(value: number | null): number {
  return value === null ? 0 : Math.sign(value);
}

function relativeChange(values: readonly number[]): { slope: number | null; relative: number | null } {
  const slope = theilSenSlope(values);
  const level = median(values);
  if (slope === null || level === null || level === 0) return { slope, relative: null };
  return { slope, relative: ((slope * (values.length - 1)) / level) * 100 };
}

function halfMedianChange(values: readonly number[]): number | null {
  const half = Math.floor(values.length / 2);
  const first = median(values.slice(0, half));
  const second = median(values.slice(values.length - half));
  return first === null || second === null ? null : percentChange(first, second);
}

/**
 * Classifies the trend of one period:
 * - insufficient_data: coverage < 90 %, too few points, or a zero median level
 * - increasing / decreasing: Mann–Kendall p < 0.05, |Theil–Sen slope over the span| ≥ 10 % of the median level, the half-medians
 *   move the same way by ≥ 10 %, and the result survives removing flagged spikes
 * - stable: |Theil–Sen slope over the span| < 10 % of the median, |half-median change| < 10 % and robust CV ≤ 0.5 (no large swings)
 * - no_clear_trend: everything else (e.g. large but non-significant or spike-driven movement)
 */
export function analyzeTrend(
  periodObservations: readonly Observation[],
  granularity: FetchGranularity,
  coverage: number | null,
  anomalyUnits: ReadonlySet<string>,
): Trend {
  const basis = granularity === 'monthly' ? 'monthly' : 'weekly_blocks';
  let series: SeriesPoint[];
  let droppedBlocks = 0;
  if (granularity === 'monthly') {
    series = countedPoints(periodObservations).map((point) => ({ key: point.period, views: point.views, inferred: point.inferred ? 1 : 0, units: [point.period] }));
  } else {
    const blocks = weeklyBlocks(periodObservations);
    droppedBlocks = blocks.dropped;
    series = blocks.blocks.map((block) => ({ key: block.start, views: block.views, inferred: block.inferredDays, units: block.units }));
  }

  const values = series.map((point) => point.views);
  const pointWord = basis === 'monthly' ? 'months' : 'complete 7-day blocks';
  const empty = {
    basis,
    points: series.length,
    droppedBlocks,
    slopePerPoint: null,
    slopeSpanPercentOfMedian: null,
    halfMedianChangePercent: null,
    robustCv: null,
    mannKendall: null,
    robustToSpikes: null,
  } as const;

  if (coverage === null || coverage < TREND_RULES.minCoverage) {
    return { ...empty, direction: 'insufficient_data', issues: ['LOW_COVERAGE'], explanation: `Coverage ${coverage === null ? 'n/a' : `${round(coverage * 100, 1)}%`} is below ${TREND_RULES.minCoverage * 100}%.` };
  }
  const minPoints = TREND_RULES.minPoints[basis];
  if (series.length < minPoints) {
    return { ...empty, direction: 'insufficient_data', issues: ['TOO_FEW_POINTS'], explanation: `${series.length} ${pointWord} available; at least ${minPoints} are needed.` };
  }
  if (median(values) === 0) {
    return { ...empty, direction: 'insufficient_data', issues: ['ZERO_LEVEL'], explanation: 'The median level is zero, so relative change is undefined.' };
  }

  const test = mannKendall(values);
  const { slope, relative } = relativeChange(values);
  const halves = halfMedianChange(values);
  const level = median(values) as number;
  const robustCv = (1.4826 * (mad(values) as number)) / level;
  const issues: Issue[] = [];
  if (series.some((point) => point.inferred > 0)) issues.push('INFERRED_ZEROS');

  const significant = test !== null && test.pValue < TREND_RULES.alpha;
  const large = relative !== null && Math.abs(relative) >= TREND_RULES.minSlopeSpanPercent;
  const halvesAgree = halves !== null && sign(halves) === sign(test?.s ?? 0) && Math.abs(halves) >= TREND_RULES.minSlopeSpanPercent;
  const small = relative !== null && Math.abs(relative) < TREND_RULES.minSlopeSpanPercent && halves !== null && Math.abs(halves) < TREND_RULES.minSlopeSpanPercent;
  const calm = robustCv <= TREND_RULES.maxStableRobustCv;

  let direction: Trend['direction'];
  let robustToSpikes: boolean | null = null;
  let explanation: string;
  const stats = `Mann–Kendall p = ${test ? round(test.pValue, 4) : 'n/a'}, Theil–Sen slope over the span ${relative === null ? 'n/a' : `${round(relative, 1)}% of the median level`}, half-median change ${halves === null ? 'n/a' : `${round(halves, 1)}%`}, robust CV ${round(robustCv, 2)} over ${series.length} ${pointWord}.`;

  if (significant && large && halvesAgree) {
    const spikeFree = series.filter((point) => !point.units.some((unit) => anomalyUnits.has(unit))).map((point) => point.views);
    if (spikeFree.length < series.length) {
      const retest = mannKendall(spikeFree);
      robustToSpikes = retest !== null && retest.pValue < TREND_RULES.alpha && sign(retest.s) === sign(test.s);
    } else {
      robustToSpikes = true;
    }
    if (robustToSpikes) {
      direction = test.s > 0 ? 'increasing' : 'decreasing';
      explanation = `Consistent monotonic ${direction === 'increasing' ? 'increase' : 'decrease'}: ${stats}`;
    } else {
      direction = 'no_clear_trend';
      issues.push('SPIKE_DRIVEN');
      explanation = `The apparent trend disappears when flagged spikes are removed: ${stats}`;
    }
  } else if (small && calm) {
    direction = 'stable';
    explanation = `Slope and half-median change stay within ±${TREND_RULES.minSlopeSpanPercent}% without large swings: ${stats}`;
  } else {
    direction = 'no_clear_trend';
    if (significant && large && !halvesAgree) issues.push('HALVES_DISAGREE');
    if (small && !calm) issues.push('HIGH_VARIABILITY');
    explanation = `No consistent monotonic trend: ${stats}`;
  }

  return {
    direction,
    basis,
    points: series.length,
    droppedBlocks,
    slopePerPoint: slope === null ? null : round(slope, 2),
    slopeSpanPercentOfMedian: relative === null ? null : round(relative, 2),
    halfMedianChangePercent: halves === null ? null : round(halves, 2),
    robustCv: round(robustCv, 4),
    mannKendall: test ? { s: test.s, pValue: round(test.pValue, 6), method: test.method } : null,
    robustToSpikes,
    issues,
    explanation,
  };
}
