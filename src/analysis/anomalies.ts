import type { FetchGranularity } from '../periods/plan.ts';
import type { Anomaly, AnomalyResult } from '../schemas/analysis.ts';
import type { CountedPoint } from './series.ts';
import { mad, median, round, sum } from './stats.ts';

/** Documented in references/METHODOLOGY.md. */
export const ANOMALY_RULES = {
  /** Neighbours considered on each side of a unit. */
  neighbours: { daily: 14, monthly: 6 },
  /** Minimum neighbours needed to judge a unit. */
  minNeighbours: { daily: 14, monthly: 5 },
  /** Scale factor making the MAD comparable to a standard deviation for normal data. */
  madScale: 1.4826,
  /** Threshold = median + k × spread. */
  k: 5,
  /** Spread floor as a share of the median, so perfectly flat baselines do not flag small wiggles. */
  minRelativeSpread: 0.1,
  /** Spread floor in views. */
  minAbsoluteSpread: 1,
  /** A spike must also be at least this many times the baseline median. */
  minRatio: 2,
} as const;

/**
 * Flags upward spikes with a rolling median/MAD baseline built from neighbouring counted units
 * (the unit itself excluded). Spikes are reported, never removed from the main metrics, and no cause is inferred.
 */
export function detectAnomalies(points: readonly CountedPoint[], granularity: FetchGranularity): AnomalyResult {
  const countedSum = sum(points.map((point) => point.views));
  const window = ANOMALY_RULES.neighbours[granularity];
  const minimum = ANOMALY_RULES.minNeighbours[granularity];
  const word = granularity === 'daily' ? 'days' : 'months';

  if (points.length < minimum + 1) {
    return {
      method: 'rolling_median_mad',
      checked: false,
      notCheckedReason: `At least ${minimum + 1} counted ${word} are needed; ${points.length} available.`,
      anomalies: [],
      countedSumExcludingAnomalies: countedSum,
    };
  }

  const anomalies: Anomaly[] = [];
  points.forEach((point, index) => {
    const neighbours = [...points.slice(Math.max(0, index - window), index), ...points.slice(index + 1, index + 1 + window)].map((p) => p.views);
    if (neighbours.length < minimum) return;
    const baselineMedian = median(neighbours) as number;
    const spread = Math.max(
      ANOMALY_RULES.madScale * (mad(neighbours) as number),
      ANOMALY_RULES.minRelativeSpread * baselineMedian,
      ANOMALY_RULES.minAbsoluteSpread,
    );
    const threshold = baselineMedian + ANOMALY_RULES.k * spread;
    const ratio = baselineMedian > 0 ? point.views / baselineMedian : null;
    if (point.views <= threshold || (ratio !== null && ratio < ANOMALY_RULES.minRatio)) return;

    anomalies.push({
      period: point.period,
      views: point.views,
      baselineMedian: round(baselineMedian, 2),
      baselineSpread: round(spread, 2),
      threshold: round(threshold, 2),
      ratioToBaseline: ratio === null ? null : round(ratio, 2),
      shareOfCountedSum: countedSum > 0 ? round(point.views / countedSum, 4) : null,
      reason:
        `${point.views} views exceeds the threshold ${round(threshold, 1)} (median ${round(baselineMedian, 1)} of ${neighbours.length} ` +
        `neighbouring ${word} + ${ANOMALY_RULES.k} × robust spread ${round(spread, 1)})` +
        (ratio === null ? '.' : ` and is ${round(ratio, 1)}× the median.`),
    });
  });

  const flagged = new Set(anomalies.map((anomaly) => anomaly.period));
  return {
    method: 'rolling_median_mad',
    checked: true,
    notCheckedReason: null,
    anomalies,
    countedSumExcludingAnomalies: sum(points.filter((point) => !flagged.has(point.period)).map((point) => point.views)),
  };
}
