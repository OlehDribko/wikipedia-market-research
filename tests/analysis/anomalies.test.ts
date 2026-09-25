import { describe, expect, it } from 'vitest';
import { detectAnomalies } from '../../src/analysis/anomalies.ts';
import { countedPoints } from '../../src/analysis/series.ts';
import { dailySeries, monthlySeries, noise } from './fixtures.ts';

function points(values: number[], start = '2025-01-01') {
  return countedPoints(dailySeries(start, values));
}

describe('detectAnomalies', () => {
  it('flags an isolated daily spike with its baseline and reason', () => {
    const values = Array.from({ length: 60 }, (_, day) => Math.round(100 + noise(day) * 5));
    values[30] = 500;
    const result = detectAnomalies(points(values), 'daily');

    expect(result.checked).toBe(true);
    expect(result.anomalies).toHaveLength(1);
    const [spike] = result.anomalies;
    expect(spike).toMatchObject({ period: '2025-01-31', views: 500 });
    expect(spike?.baselineMedian).toBeGreaterThan(95);
    expect(spike?.baselineMedian).toBeLessThan(105);
    expect(spike?.ratioToBaseline).toBeGreaterThan(4.5);
    expect(spike?.reason).toContain('neighbouring days');
    expect(spike?.shareOfCountedSum).toBeCloseTo(500 / values.reduce((a, b) => a + b, 0), 4);
    expect(result.countedSumExcludingAnomalies).toBe(values.reduce((a, b) => a + b, 0) - 500);
  });

  it('does not flag steady growth or ordinary weekday cycles', () => {
    const growth = Array.from({ length: 90 }, (_, day) => 100 + day * 3 + (day % 7 < 5 ? 20 : -20));
    expect(detectAnomalies(points(growth), 'daily').anomalies).toEqual([]);
  });

  it('flags a spike month in monthly data', () => {
    const values = [1000, 1020, 980, 1010, 990, 5000, 1005, 995, 1015, 985, 1000, 1010];
    const result = detectAnomalies(countedPoints(monthlySeries('2025-01-01', values)), 'monthly');
    expect(result.anomalies.map((anomaly) => anomaly.period)).toEqual(['2025-06-01']);
    expect(result.anomalies[0]?.reason).toContain('neighbouring months');
  });

  it('handles zero baselines without dividing by zero', () => {
    const values = Array.from({ length: 30 }, () => 0);
    values[15] = 40;
    const [spike] = detectAnomalies(points(values), 'daily').anomalies;
    expect(spike).toMatchObject({ views: 40, baselineMedian: 0, ratioToBaseline: null });
  });

  it('does not judge series that are too short', () => {
    const result = detectAnomalies(points([1, 2, 300, 4, 5]), 'daily');
    expect(result).toMatchObject({ checked: false, anomalies: [] });
    expect(result.notCheckedReason).toContain('At least 15');
  });
});
