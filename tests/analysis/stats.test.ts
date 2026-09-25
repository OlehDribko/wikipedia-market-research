import { describe, expect, it } from 'vitest';
import { mad, mannKendall, median, normalCdf, percentChange, round, sum, theilSenSlope } from '../../src/analysis/stats.ts';

describe('basic statistics', () => {
  it('computes sum, median and MAD', () => {
    expect(sum([1, 2, 3])).toBe(6);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(mad([1, 1, 2, 2, 4, 6, 9])).toBe(1);
  });

  it('rounds half away from zero without negative zero', () => {
    expect(round(2.345, 2)).toBe(2.35);
    expect(round(-2.345, 2)).toBe(-2.35);
    expect(Object.is(round(-0.0001, 2), 0)).toBe(true);
  });

  it('computes percentage growth and decline', () => {
    expect(percentChange(200, 250)).toBe(25);
    expect(percentChange(200, 150)).toBe(-25);
    expect(percentChange(200, 200)).toBe(0);
  });

  it('returns null instead of dividing by zero', () => {
    expect(percentChange(0, 10)).toBeNull();
    expect(percentChange(0, 0)).toBeNull();
  });
});

describe('theilSenSlope', () => {
  it('recovers a linear slope and ignores a single outlier', () => {
    expect(theilSenSlope([10, 12, 14, 16, 18])).toBe(2);
    expect(theilSenSlope([10, 12, 14, 1000, 18, 20, 22])).toBe(2);
    expect(theilSenSlope([5])).toBeNull();
  });
});

describe('mannKendall', () => {
  it('uses the exact distribution for small series without ties', () => {
    // Strictly increasing: only 1 of n! orderings is at least this extreme in each direction.
    expect(mannKendall([1, 2, 3, 4])).toEqual({ s: 6, n: 4, pValue: 2 / 24, method: 'exact' });
    expect(mannKendall([5, 4, 3, 2, 1])?.pValue).toBeCloseTo(2 / 120, 12);
    expect(mannKendall([5, 4, 3, 2, 1])?.s).toBe(-10);
  });

  it('gives p = 1 for a series without monotonic tendency', () => {
    expect(mannKendall([1, 3, 2, 4, 3, 2])?.method).toBe('normal_approximation'); // ties
    expect(mannKendall([2, 1, 4, 3])?.pValue).toBeGreaterThan(0.5);
  });

  it('uses a tie-corrected normal approximation for ties and long series', () => {
    const long = Array.from({ length: 40 }, (_, index) => index);
    const result = mannKendall(long);
    expect(result?.method).toBe('normal_approximation');
    expect(result?.pValue).toBeLessThan(1e-6);
    expect(mannKendall([3, 3, 3, 3])).toEqual({ s: 0, n: 4, pValue: 1, method: 'normal_approximation' });
  });

  it('needs at least 3 points', () => {
    expect(mannKendall([1, 2])).toBeNull();
  });

  it('computes the normal CDF accurately', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
  });
});
