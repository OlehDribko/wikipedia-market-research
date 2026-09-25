import { describe, expect, it } from 'vitest';
import { analyzeResearch } from '../../src/analysis/analyze.ts';
import { AnalysisSchema, type Comparison } from '../../src/schemas/analysis.ts';
import { ConclusionsSchema } from '../../src/schemas/conclusions.ts';
import type { Observation } from '../../src/schemas/observation.ts';
import { dailySeries, dataset, inferredZero, missing, monthlySeries } from './fixtures.ts';

const H1_2024 = { id: 'compare-1', start: '2024-01-01', end: '2024-06-30' };
const H1_2025 = { id: 'compare-2', start: '2025-01-01', end: '2025-06-30' };

function monthly(values: (number | null)[], start = '2024-01-01'): Observation[] {
  return monthlySeries(start, values);
}

function compare(observations: Observation[], periods: { id: string; start: string; end: string }[], granularity: 'daily' | 'monthly' = 'monthly') {
  const { analysis, warnings } = analyzeResearch([dataset('uk', granularity, observations)], { periods });
  AnalysisSchema.parse(analysis);
  return { comparison: analysis.comparisons[0] as Comparison, analysis, warnings };
}

describe('period comparisons', () => {
  const flat = [100, 100, 100, 100, 100, 100];

  it('computes growth between aligned periods of equal length', () => {
    const { comparison } = compare([...monthly(flat), ...monthly([150, 150, 150, 150, 150, 150], '2025-01-01')], [H1_2024, H1_2025]);
    expect(comparison).toMatchObject({
      id: 'compare-1_vs_compare-2',
      baseline: { total: 600, durationDays: 182 },
      current: { total: 900, durationDays: 181 },
      absoluteChange: 300,
      percentChange: 50,
      primaryMeasure: 'averageDaily',
      issues: ['UNEQUAL_DURATION'],
    });
  });

  it('prefers totals only when durations are equal', () => {
    const periods = [
      { id: 'compare-1', start: '2023-01-01', end: '2023-06-30' },
      { id: 'compare-2', start: '2025-01-01', end: '2025-06-30' },
    ];
    const { comparison } = compare([...monthly(flat, '2023-01-01'), ...monthly([80, 80, 80, 80, 80, 80], '2025-01-01')], periods);
    expect(comparison).toMatchObject({ percentChange: -20, averageDailyPercentChange: -20, primaryMeasure: 'total', status: 'comparable', issues: [] });
  });

  it('normalizes unequal durations with average daily views', () => {
    // 1 month vs 3 months at the same daily intensity: totals triple, intensity is unchanged.
    const periods = [
      { id: 'compare-1', start: '2025-01-01', end: '2025-01-31' },
      { id: 'compare-2', start: '2025-02-01', end: '2025-04-30' },
    ];
    const { comparison, warnings } = compare(monthly([310, 280, 310, 300], '2025-01-01'), periods);
    expect(comparison).toMatchObject({ absoluteChange: 580, percentChange: 187.1, averageDailyPercentChange: 0, equalDuration: false, primaryMeasure: 'averageDaily' });
    expect(comparison.issues).toEqual(expect.arrayContaining(['UNEQUAL_DURATION', 'SEASONALITY_NOT_ALIGNED']));
    expect(warnings.map((warning) => warning.code)).toContain('UNEQUAL_PERIOD_LENGTH');
  });

  it('handles a zero baseline without dividing by zero', () => {
    const periods = [
      { id: 'compare-1', start: '2024-01-01', end: '2024-01-31' },
      { id: 'compare-2', start: '2025-01-01', end: '2025-01-31' },
    ];
    const { comparison, warnings } = compare([...monthly([0]), ...monthly([90], '2025-01-01')], periods);
    expect(comparison).toMatchObject({ absoluteChange: 90, percentChange: null, averageDailyPercentChange: null, primaryMeasure: null, status: 'insufficient_data' });
    expect(comparison.nullReasons).toMatchObject({ percentChange: 'BASELINE_ZERO', averageDailyPercentChange: 'BASELINE_ZERO' });
    expect(warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(['BASELINE_ZERO', 'COMPARISON_NOT_POSSIBLE']));
  });

  it('compares the completed part of an incomplete period by daily average only', () => {
    const periods = [
      { id: 'compare-1', start: '2025-01-01', end: '2025-01-10' },
      { id: 'compare-2', start: '2026-01-01', end: '2026-01-10' },
    ];
    const current = [...dailySeries('2026-01-01', [20, 20, 20, 20, 20]), ...['06', '07', '08', '09', '10'].map((day) => missing(`2026-01-${day}`, 'incomplete'))];
    const { comparison } = compare([...dailySeries('2025-01-01', Array(10).fill(10)), ...current], periods, 'daily');
    expect(comparison).toMatchObject({ percentChange: null, averageDailyPercentChange: 100, primaryMeasure: 'averageDaily', status: 'comparable_with_limitations' });
    expect(comparison.nullReasons.percentChange).toBe('PERIOD_INCOMPLETE');
    expect(comparison.issues).toContain('PERIOD_INCOMPLETE');
  });

  it('reports insufficient data when coverage is too low', () => {
    const { comparison } = compare([...monthly([100, null, null, 100, 100, 100]), ...monthly(flat, '2025-01-01')], [H1_2024, H1_2025]);
    expect(comparison).toMatchObject({ status: 'insufficient_data', percentChange: null, averageDailyPercentChange: null });
    expect(comparison.issues).toEqual(expect.arrayContaining(['MISSING_UNITS', 'INSUFFICIENT_COVERAGE']));
  });

  it('flags inferred zeros, overlapping periods and spikes', () => {
    const periods = [
      { id: 'compare-1', start: '2025-01-01', end: '2025-02-28' },
      { id: 'compare-2', start: '2025-02-01', end: '2025-03-31' },
    ];
    const observations = monthly([inferredZero('2025-01-01').views ?? 0, 50, 60], '2025-01-01');
    observations[0] = inferredZero('2025-01-01');
    const { comparison } = compare(observations, periods);
    expect(comparison.issues).toEqual(expect.arrayContaining(['INFERRED_ZEROS', 'PERIODS_OVERLAP']));
  });

  it('compares consecutive comparison periods in the user order', () => {
    const periods = [
      { id: 'compare-1', start: '2025-01-01', end: '2025-01-31' },
      { id: 'compare-2', start: '2023-01-01', end: '2023-01-31' },
      { id: 'compare-3', start: '2024-01-01', end: '2024-01-31' },
    ];
    const observations = [...monthly([300], '2023-01-01'), ...monthly([200], '2024-01-01'), ...monthly([100], '2025-01-01')];
    const { analysis } = analyzeResearch([dataset('uk', 'monthly', observations)], { periods });
    expect(analysis.comparisons.map((comparison) => [comparison.id, comparison.percentChange])).toEqual([
      ['compare-1_vs_compare-2', 200],
      ['compare-2_vs_compare-3', -33.33],
    ]);
  });
});

describe('cross-language analysis', () => {
  const main = { id: 'main', start: '2025-01-01', end: '2025-12-31' };
  const uk = dataset('uk', 'monthly', monthly([100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210], '2025-01-01'), {
    title: 'Астрономія',
    url: 'https://uk.wikipedia.org/wiki/%D0%90',
  });
  const pl = dataset('pl', 'monthly', monthly(Array(12).fill(500), '2025-01-01'), { title: 'Astronomia', wikidataId: 'Q333' });

  it('returns indicators separately per language and preserves identity', () => {
    const { analysis } = analyzeResearch([uk, pl], { periods: [main] });
    expect(analysis.languages.map((language) => [language.lang, language.title, language.url, language.wikidataId])).toEqual([
      ['uk', 'Астрономія', 'https://uk.wikipedia.org/wiki/%D0%90', 'Q333'],
      ['pl', 'Astronomia', 'https://pl.wikipedia.org/wiki/Title', 'Q333'],
    ]);
    expect(analysis.languages[0]?.periods[0]?.trend.direction).toBe('increasing');
    expect(analysis.languages[1]?.periods[0]?.trend.direction).toBe('stable');
    expect(analysis.crossLanguage).toEqual([
      {
        periodId: 'main',
        ranking: [
          { lang: 'pl', title: 'Astronomia', averageDaily: 16.44, total: 6000, trend: 'stable' },
          { lang: 'uk', title: 'Астрономія', averageDaily: 5.1, total: 1860, trend: 'increasing' },
        ],
      },
    ]);
  });

  it('indexes metrics under stable IDs that conclusions can cite', () => {
    const periods = [H1_2024, H1_2025];
    const both = [...monthly([100, 100, 100, 100, 100, 100]), ...monthly([150, 150, 150, 150, 150, 150], '2025-01-01')];
    const { analysis } = analyzeResearch([dataset('uk', 'monthly', both)], { periods });
    expect(analysis.metrics['uk.compare-1.total']).toEqual({ value: 600, unit: 'views', lang: 'uk', periodId: 'compare-1', comparisonId: null });
    expect(analysis.metrics['uk.compare-1_vs_compare-2.percentChange']).toMatchObject({ value: 50, unit: 'percent', comparisonId: 'compare-1_vs_compare-2' });
    expect(analysis.metrics['uk.compare-2.trend.direction']?.unit).toBe('label');
    // Every ID must be accepted by the conclusions schema used by the report.
    const conclusions = {
      language: 'en',
      headline: 'x',
      findings: [{ statement: 'x', evidence: Object.keys(analysis.metrics) }],
      hypotheses: [],
      limitations: ['x'],
    };
    expect(ConclusionsSchema.safeParse(conclusions).success).toBe(true);
  });

  it('keeps spikes in the main statistics', () => {
    const values = [1000, 1020, 980, 1010, 990, 5000, 1005, 995, 1015, 985, 1000, 1010];
    const { analysis, warnings } = analyzeResearch([dataset('uk', 'monthly', monthly(values, '2025-01-01'))], { periods: [main] });
    const period = analysis.languages[0]?.periods[0];
    expect(period?.metrics.total).toBe(values.reduce((a, b) => a + b, 0));
    expect(period?.anomalies.anomalies).toHaveLength(1);
    expect(period?.anomalies.countedSumExcludingAnomalies).toBe(values.reduce((a, b) => a + b, 0) - 5000);
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'SPIKES_DETECTED', language: 'uk' }));
  });

  it('propagates data-quality problems as language-specific warnings', () => {
    const gappy = dataset('de', 'monthly', monthly([100, null, null, 100, 100, 100, 100, 100, 100, 100, 100, 100], '2025-01-01'));
    const { warnings } = analyzeResearch([pl, gappy], { periods: [main] });
    expect(warnings).toEqual([expect.objectContaining({ code: 'TOTAL_NOT_CALCULATED', language: 'de' }), expect.objectContaining({ code: 'AVERAGE_NOT_CALCULATED', language: 'de' })]);
  });

  it('warns that a directional trend over less than a year may be seasonal', () => {
    const values = Array.from({ length: 84 }, (_, day) => 100 + day * 2);
    const { analysis, warnings } = analyzeResearch([dataset('uk', 'daily', dailySeries('2025-06-01', values))], {
      periods: [{ id: 'main', start: '2025-06-01', end: '2025-08-23' }],
    });
    expect(analysis.languages[0]?.periods[0]?.trend).toMatchObject({ direction: 'increasing', issues: ['SHORT_SPAN'] });
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'TREND_MAY_BE_SEASONAL', language: 'uk' }));
  });

  it('is deterministic', () => {
    expect(analyzeResearch([uk, pl], { periods: [main] })).toEqual(analyzeResearch([uk, pl], { periods: [main] }));
  });
});
