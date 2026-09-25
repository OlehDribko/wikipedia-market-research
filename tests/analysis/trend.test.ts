import { describe, expect, it } from 'vitest';
import { analyzeTrend } from '../../src/analysis/trend.ts';
import { dailySeries, inferredZero, monthlySeries, noise } from './fixtures.ts';

const none = new Set<string>();

describe('analyzeTrend: monthly data', () => {
  it('detects an increasing trend', () => {
    const values = Array.from({ length: 12 }, (_, index) => Math.round(1000 + index * 60 + noise(index) * 40));
    const trend = analyzeTrend(monthlySeries('2025-01-01', values), 'monthly', 1, none);
    expect(trend.direction).toBe('increasing');
    expect(trend.basis).toBe('monthly');
    expect(trend.mannKendall?.pValue).toBeLessThan(0.05);
    expect(trend.slopeSpanPercentOfMedian).toBeGreaterThan(10);
    expect(trend.robustToSpikes).toBe(true);
  });

  it('detects a decreasing trend', () => {
    const values = Array.from({ length: 12 }, (_, index) => Math.round(2000 - index * 90 + noise(index) * 50));
    const trend = analyzeTrend(monthlySeries('2025-01-01', values), 'monthly', 1, none);
    expect(trend.direction).toBe('decreasing');
    expect(trend.slopeSpanPercentOfMedian).toBeLessThan(-10);
  });

  it('classifies small fluctuations as stable', () => {
    const values = Array.from({ length: 12 }, (_, index) => Math.round(1000 + noise(index) * 30));
    const trend = analyzeTrend(monthlySeries('2025-01-01', values), 'monthly', 1, none);
    expect(trend.direction).toBe('stable');
    expect(Math.abs(trend.slopeSpanPercentOfMedian ?? 99)).toBeLessThan(10);
  });

  it('does not call large swings without direction stable', () => {
    const vShape = [300, 250, 200, 150, 100, 50, 50, 100, 150, 200, 250, 300];
    const trend = analyzeTrend(monthlySeries('2025-01-01', vShape), 'monthly', 1, none);
    expect(trend.direction).toBe('no_clear_trend');
    expect(trend.issues).toContain('HIGH_VARIABILITY');
  });

  it('does not derive a trend from percentage change alone', () => {
    // First and last values differ by 100 %, but the series has no monotonic tendency.
    const values = [100, 180, 90, 170, 95, 175, 100, 185, 90, 170, 95, 200];
    const trend = analyzeTrend(monthlySeries('2025-01-01', values), 'monthly', 1, none);
    expect(trend.direction).not.toBe('increasing');
  });

  it('reports a spike-driven increase as no_clear_trend', () => {
    const values = [100, 101, 99, 100, 102, 98, 100, 200, 210, 220, 230, 240];
    const observations = monthlySeries('2025-01-01', values);
    const spikes = new Set(observations.slice(7).map((observation) => observation.period));
    expect(analyzeTrend(observations, 'monthly', 1, none).direction).toBe('increasing');
    const trend = analyzeTrend(observations, 'monthly', 1, spikes);
    expect(trend).toMatchObject({ direction: 'no_clear_trend', robustToSpikes: false });
    expect(trend.issues).toContain('SPIKE_DRIVEN');
  });

  it('needs at least 6 months', () => {
    const trend = analyzeTrend(monthlySeries('2025-01-01', [1, 2, 3, 4, 5]), 'monthly', 1, none);
    expect(trend).toMatchObject({ direction: 'insufficient_data', issues: ['TOO_FEW_POINTS'], mannKendall: null });
  });

  it('needs at least 90 % coverage', () => {
    const trend = analyzeTrend(monthlySeries('2025-01-01', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 'monthly', 0.85, none);
    expect(trend).toMatchObject({ direction: 'insufficient_data', issues: ['LOW_COVERAGE'] });
  });

  it('refuses a relative trend when the median level is zero', () => {
    const trend = analyzeTrend(monthlySeries('2025-01-01', [0, 0, 0, 0, 0, 0, 5, 0]), 'monthly', 1, none);
    expect(trend).toMatchObject({ direction: 'insufficient_data', issues: ['ZERO_LEVEL'] });
  });

  it('flags inferred zeros used in the trend', () => {
    const observations = monthlySeries('2025-01-01', [10, 12, 14, 16, 18, 20, 22, 24]);
    observations[0] = inferredZero('2025-01-01');
    expect(analyzeTrend(observations, 'monthly', 1, none).issues).toContain('INFERRED_ZEROS');
  });
});

describe('analyzeTrend: daily data', () => {
  it('uses complete 7-day blocks, removing the weekday cycle', () => {
    // 70 days: strong weekday pattern plus steady growth.
    const values = Array.from({ length: 70 }, (_, day) => Math.round(100 + day * 2 + (day % 7 < 5 ? 30 : -30)));
    const trend = analyzeTrend(dailySeries('2025-01-01', values), 'daily', 1, none);
    expect(trend).toMatchObject({ direction: 'increasing', basis: 'weekly_blocks', points: 10, droppedBlocks: 0 });
  });

  it('keeps a flat series with a weekday cycle stable', () => {
    const values = Array.from({ length: 84 }, (_, day) => 100 + (day % 7 < 5 ? 30 : -30) + Math.round(noise(day) * 5));
    expect(analyzeTrend(dailySeries('2025-01-01', values), 'daily', 1, none).direction).toBe('stable');
  });

  it('drops blocks with missing days and needs 8 complete blocks', () => {
    // 56 days = 8 blocks; one missing day drops its block, leaving 7.
    const values: (number | null)[] = Array.from({ length: 56 }, (_, day) => 100 + day);
    values[3] = null;
    const trend = analyzeTrend(dailySeries('2025-01-01', values), 'daily', 0.98, none);
    expect(trend).toMatchObject({ direction: 'insufficient_data', points: 7, droppedBlocks: 1 });
    expect(trend.issues).toEqual(['TOO_FEW_POINTS']);
  });
});
