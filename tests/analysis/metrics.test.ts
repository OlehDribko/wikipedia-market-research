import { describe, expect, it } from 'vitest';
import { periodMetrics } from '../../src/analysis/metrics.ts';
import { dailySeries, inferredZero, missing, monthlySeries, observed } from './fixtures.ts';

const tenDays = { start: '2025-01-01', end: '2025-01-10' };

describe('periodMetrics', () => {
  it('computes total, averages, extremes and concentration for complete daily data', () => {
    const metrics = periodMetrics(dailySeries('2025-01-01', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), tenDays, 'daily');
    expect(metrics).toMatchObject({
      durationDays: 10,
      coverage: 1,
      total: 55,
      countedSum: 55,
      averageDaily: 5.5,
      averageMonthly: null,
      min: { period: '2025-01-01', views: 1, inferred: false },
      max: { period: '2025-01-10', views: 10, inferred: false },
      largestUnitShare: 0.1818,
      nullReasons: { averageMonthly: 'DAILY_GRANULARITY' },
    });
  });

  it('computes monthly totals, per-day and per-month averages', () => {
    const metrics = periodMetrics(monthlySeries('2025-01-01', [310, 280]), { start: '2025-01-01', end: '2025-02-28' }, 'monthly');
    expect(metrics).toMatchObject({ durationDays: 59, total: 590, averageDaily: 10, averageMonthly: 295, nullReasons: {} });
  });

  it('withholds the total but keeps averages when a few units are missing', () => {
    const metrics = periodMetrics(dailySeries('2025-01-01', [10, 10, 10, 10, null, 10, 10, 10, 10, 10]), tenDays, 'daily');
    expect(metrics).toMatchObject({ coverage: 0.9, total: null, countedSum: 90, averageDaily: 10, units: { missing: 1, counted: 9 } });
    expect(metrics.nullReasons.total).toBe('MISSING_UNITS');
  });

  it('withholds averages when coverage is below 90 %', () => {
    const metrics = periodMetrics(dailySeries('2025-01-01', [10, 10, 10, 10, null, null, 10, 10, 10, 10]), tenDays, 'daily');
    expect(metrics).toMatchObject({ coverage: 0.8, total: null, averageDaily: null });
    expect(metrics.nullReasons).toMatchObject({ total: 'MISSING_UNITS', averageDaily: 'INSUFFICIENT_COVERAGE' });
  });

  it('does not report a total for an incomplete period but averages the completed part', () => {
    const observations = [...dailySeries('2025-01-01', [4, 6, 8]), missing('2025-01-04', 'incomplete'), missing('2025-01-05', 'incomplete')];
    const metrics = periodMetrics(observations, { start: '2025-01-01', end: '2025-01-05' }, 'daily');
    expect(metrics).toMatchObject({ total: null, countedSum: 18, averageDaily: 6, coverage: 1, units: { incomplete: 2, expected: 3 } });
    expect(metrics.nullReasons.total).toBe('PERIOD_INCOMPLETE');
  });

  it('includes inferred zero-view units as zeros but keeps them distinguishable', () => {
    const observations = [observed('2025-01-01', 6), inferredZero('2025-01-02'), observed('2025-01-03', 0), observed('2025-01-04', 2)];
    const metrics = periodMetrics(observations, { start: '2025-01-01', end: '2025-01-04' }, 'daily');
    expect(metrics).toMatchObject({ total: 8, averageDaily: 2, units: { observed: 3, inferredZero: 1, counted: 4 } });
    expect(metrics.min).toEqual({ period: '2025-01-02', views: 0, inferred: true });
  });

  it('averages only over the article lifetime when the period starts before creation', () => {
    const observations = [missing('2025-01-01', 'before_creation'), missing('2025-01-02', 'before_creation'), ...dailySeries('2025-01-03', [5, 7])];
    const metrics = periodMetrics(observations, { start: '2025-01-01', end: '2025-01-04' }, 'daily');
    expect(metrics).toMatchObject({ total: 12, averageDaily: 6, coverage: 1, units: { beforeCreation: 2, expected: 2 } });
  });

  it('returns nulls with NO_DATA when nothing can be counted', () => {
    const metrics = periodMetrics([missing('2025-01-01', 'before_creation')], { start: '2025-01-01', end: '2025-01-01' }, 'daily');
    expect(metrics).toMatchObject({ total: null, averageDaily: null, coverage: null, min: null, max: null, largestUnitShare: null });
    expect(metrics.nullReasons).toMatchObject({ total: 'NO_DATA', averageDaily: 'NO_DATA' });
  });

  it('handles a single-day dataset', () => {
    const metrics = periodMetrics([observed('2025-01-01', 42)], { start: '2025-01-01', end: '2025-01-01' }, 'daily');
    expect(metrics).toMatchObject({ total: 42, averageDaily: 42, largestUnitShare: 1, durationDays: 1 });
  });
});
