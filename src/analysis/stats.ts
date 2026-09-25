/** Pure numeric helpers. All functions leave their inputs unchanged. */

export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Median absolute deviation from the median (unscaled). */
export function mad(values: readonly number[]): number | null {
  const center = median(values);
  if (center === null) return null;
  return median(values.map((value) => Math.abs(value - center)));
}

/** Rounds half away from zero and normalizes -0 to 0. */
export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  const rounded = (Math.sign(value) * Math.round(Math.abs(value) * factor)) / factor;
  return rounded === 0 ? 0 : rounded;
}

/** Percentage change from `baseline` to `current`; null when the baseline is zero (undefined ratio). */
export function percentChange(baseline: number, current: number): number | null {
  if (baseline === 0) return null;
  return ((current - baseline) / baseline) * 100;
}

/** Theil–Sen estimator: median of all pairwise slopes, with x = position (0, 1, 2, …). Robust to outliers. */
export function theilSenSlope(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const slopes: number[] = [];
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) slopes.push(((values[j] as number) - (values[i] as number)) / (j - i));
  }
  return median(slopes);
}

/** Abramowitz & Stegun 7.1.26; absolute error below 1.5e-7. */
function erf(x: number): number {
  const sign = Math.sign(x);
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const polynomial = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - polynomial * Math.exp(-x * x));
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Probability of each inversion count among random permutations of n items (Mahonian distribution). */
function inversionDistribution(n: number): number[] {
  let distribution = [1];
  for (let size = 2; size <= n; size++) {
    const next = new Array<number>(distribution.length + size - 1).fill(0);
    for (let inversions = 0; inversions < distribution.length; inversions++) {
      const share = (distribution[inversions] as number) / size;
      for (let added = 0; added < size; added++) next[inversions + added] = (next[inversions + added] as number) + share;
    }
    distribution = next;
  }
  return distribution;
}

export interface MannKendallResult {
  /** Sum of signs over all ordered pairs; positive = values tend to increase. */
  s: number;
  n: number;
  /** Two-sided p-value for H0: no monotonic trend. */
  pValue: number;
  method: 'exact' | 'normal_approximation';
}

/** Largest n for which the exact null distribution is used (ties force the normal approximation). */
export const MANN_KENDALL_EXACT_MAX_N = 30;

/**
 * Mann–Kendall test for a monotonic trend. Exact null distribution (via inversion counts) for
 * n ≤ 30 without ties; otherwise the normal approximation with tie-corrected variance and continuity correction.
 * Assumes independent observations.
 */
export function mannKendall(values: readonly number[]): MannKendallResult | null {
  const n = values.length;
  if (n < 3) return null;

  let s = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) s += Math.sign((values[j] as number) - (values[i] as number));
  }

  const tieGroups = new Map<number, number>();
  for (const value of values) tieGroups.set(value, (tieGroups.get(value) ?? 0) + 1);
  const hasTies = tieGroups.size < n;

  if (!hasTies && n <= MANN_KENDALL_EXACT_MAX_N) {
    const pairs = (n * (n - 1)) / 2;
    const distribution = inversionDistribution(n);
    // S = pairs − 2·inversions; sum the probability of every outcome at least as extreme as |S|.
    let pValue = 0;
    distribution.forEach((probability, inversions) => {
      if (Math.abs(pairs - 2 * inversions) >= Math.abs(s)) pValue += probability;
    });
    return { s, n, pValue: Math.min(1, pValue), method: 'exact' };
  }

  let tieTerm = 0;
  for (const size of tieGroups.values()) tieTerm += size * (size - 1) * (2 * size + 5);
  const variance = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18;
  if (variance <= 0) return { s, n, pValue: 1, method: 'normal_approximation' };
  const z = s > 0 ? (s - 1) / Math.sqrt(variance) : s < 0 ? (s + 1) / Math.sqrt(variance) : 0;
  return { s, n, pValue: Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))), method: 'normal_approximation' };
}
