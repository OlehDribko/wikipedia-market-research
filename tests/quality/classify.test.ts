import { describe, expect, it } from 'vitest';
import { classifyObservations, type ClassificationInput, type FetchedChunk } from '../../src/quality/classify.ts';
import { dedupeWarnings, qualityWarnings, summarizeQuality } from '../../src/quality/summary.ts';
import { ObservationSchema } from '../../src/schemas/observation.ts';

function ok(start: string, end: string, rows: Record<string, number>): FetchedChunk {
  return { start, end, outcome: { kind: 'ok', rows: new Map(Object.entries(rows)) } };
}

function classify(overrides: Partial<ClassificationInput>) {
  const observations = classifyObservations({
    units: [],
    granularity: 'daily',
    today: '2026-01-10',
    publishedThrough: '2026-01-09',
    createdOn: '2020-01-01',
    chunks: [],
    ...overrides,
  });
  for (const observation of observations) ObservationSchema.parse(observation);
  return observations;
}

function statuses(observations: { period: string; status: string; certainty: string; views: number | null }[]) {
  return observations.map((observation) => [observation.period, observation.status, observation.certainty, observation.views]);
}

describe('classifyObservations', () => {
  it('marks returned rows as observed, including explicit zero rows', () => {
    const result = classify({ units: ['2025-01-01', '2025-01-02'], chunks: [ok('2025-01-01', '2025-12-31', { '2025-01-01': 5, '2025-01-02': 0 })] });
    expect(statuses(result)).toEqual([
      ['2025-01-01', 'observed', 'established', 5],
      ['2025-01-02', 'observed', 'established', 0],
    ]);
  });

  it('treats units omitted from a successful response as uncertain zero views', () => {
    const [observation] = classify({ units: ['2025-01-02'], chunks: [ok('2025-01-01', '2025-12-31', { '2025-01-01': 5 })] });
    expect(observation).toMatchObject({ status: 'zero_omitted', views: 0, certainty: 'uncertain' });
  });

  it('never infers zero views from HTTP 404', () => {
    const [observation] = classify({ units: ['2025-01-02'], chunks: [{ start: '2025-01-01', end: '2025-12-31', outcome: { kind: 'no_data' } }] });
    expect(observation).toMatchObject({ status: 'unavailable', views: null, certainty: 'uncertain' });
    expect(observation?.reason).toContain('HTTP 404');
  });

  it('never infers a creation date from HTTP 404', () => {
    const [observation] = classify({ createdOn: null, units: ['2025-01-02'], chunks: [{ start: '2025-01-01', end: '2025-12-31', outcome: { kind: 'no_data' } }] });
    expect(observation?.status).toBe('unavailable');
  });

  it('marks units before the first revision as before_creation', () => {
    const result = classify({
      createdOn: '2022-12-05',
      units: ['2022-12-04', '2022-12-05', '2022-12-06'],
      chunks: [ok('2022-01-01', '2022-12-31', { '2022-12-06': 100 })],
    });
    expect(statuses(result)).toEqual([
      ['2022-12-04', 'before_creation', 'established', null],
      ['2022-12-05', 'zero_omitted', 'uncertain', 0],
      ['2022-12-06', 'observed', 'established', 100],
    ]);
  });

  it('treats the creation month as part of the lifetime for monthly data', () => {
    const result = classify({
      granularity: 'monthly',
      createdOn: '2022-12-05',
      units: ['2022-11-01', '2022-12-01'],
      chunks: [ok('2022-01-01', '2022-12-31', {})],
    });
    expect(result.map((observation) => observation.status)).toEqual(['before_creation', 'zero_omitted']);
  });

  it('keeps early gaps uncertain when the creation date is unknown', () => {
    const result = classify({
      createdOn: null,
      units: ['2025-01-01', '2025-01-02', '2025-01-03'],
      chunks: [ok('2025-01-01', '2025-12-31', { '2025-01-02': 3 })],
    });
    expect(statuses(result)).toEqual([
      ['2025-01-01', 'unavailable', 'uncertain', null],
      ['2025-01-02', 'observed', 'established', 3],
      ['2025-01-03', 'zero_omitted', 'uncertain', 0],
    ]);
  });

  it('marks failed requests as api_error without a value', () => {
    const [observation] = classify({ units: ['2025-01-02'], chunks: [{ start: '2025-01-01', end: '2025-12-31', outcome: { kind: 'error', message: 'HTTP 503' } }] });
    expect(observation).toMatchObject({ status: 'api_error', views: null, certainty: 'established' });
    expect(observation?.reason).toContain('HTTP 503');
  });

  it('marks today and later as incomplete, even if a value exists', () => {
    const result = classify({
      units: ['2026-01-09', '2026-01-10', '2026-01-11'],
      chunks: [ok('2026-01-01', '2026-01-09', { '2026-01-09': 4, '2026-01-10': 2 })],
    });
    expect(result.map((observation) => [observation.period, observation.status, observation.views])).toEqual([
      ['2026-01-09', 'observed', 4],
      ['2026-01-10', 'incomplete', null],
      ['2026-01-11', 'incomplete', null],
    ]);
  });

  it('marks the current month as incomplete for monthly data', () => {
    const result = classify({ granularity: 'monthly', today: '2026-01-31', units: ['2025-12-01', '2026-01-01'], chunks: [ok('2025-01-01', '2025-12-31', { '2025-12-01': 9 })] });
    expect(result.map((observation) => observation.status)).toEqual(['observed', 'incomplete']);
  });

  it('separates not-yet-published units from zero views', () => {
    const result = classify({
      publishedThrough: '2026-01-07',
      units: ['2026-01-07', '2026-01-08', '2026-01-09'],
      chunks: [ok('2026-01-01', '2026-01-09', { '2026-01-06': 1 })],
    });
    expect(statuses(result)).toEqual([
      ['2026-01-07', 'zero_omitted', 'uncertain', 0],
      ['2026-01-08', 'unavailable', 'established', null],
      ['2026-01-09', 'unavailable', 'established', null],
    ]);
  });

  it('marks units before 2015-07-01 as unavailable', () => {
    const [observation] = classify({ units: ['2015-06-30'], chunks: [] });
    expect(observation).toMatchObject({ status: 'unavailable', certainty: 'established' });
  });

  it('handles inclusive boundaries across chunks (year change)', () => {
    const result = classify({
      units: ['2024-12-31', '2025-01-01'],
      chunks: [ok('2024-01-01', '2024-12-31', { '2024-12-31': 1 }), ok('2025-01-01', '2025-12-31', { '2025-01-01': 2 })],
    });
    expect(result.map((observation) => observation.views)).toEqual([1, 2]);
  });
});

describe('summarizeQuality and qualityWarnings', () => {
  const observations = classify({
    createdOn: '2025-01-02',
    units: ['2025-01-01', '2025-01-02', '2025-01-03', '2025-01-04', '2026-01-10'],
    chunks: [ok('2025-01-01', '2025-12-31', { '2025-01-02': 5 }), { start: '2026-01-01', end: '2026-01-09', outcome: { kind: 'ok', rows: new Map() } }],
  });

  it('computes coverage per period without penalising zero-view omissions', () => {
    const quality = summarizeQuality(observations, [{ id: 'main', start: '2025-01-01', end: '2026-01-10' }, { id: 'jan', start: '2025-01-03', end: '2025-01-04' }], 'daily');
    expect(quality.counts).toMatchObject({ observed: 1, zero_omitted: 2, before_creation: 1, incomplete: 1 });
    expect(quality.uncertain).toBe(2);
    expect(quality.byPeriod[0]).toMatchObject({ periodId: 'main', units: 5, expected: 3, counted: 3, coverage: 1 });
    expect(quality.byPeriod[1]).toMatchObject({ periodId: 'jan', units: 2, expected: 2, counted: 2, coverage: 1 });
  });

  it('reports low coverage and every data-quality issue as warnings', () => {
    const withGaps = classify({
      units: ['2025-01-01', '2025-01-02', '2025-01-03'],
      chunks: [{ start: '2025-01-01', end: '2025-12-31', outcome: { kind: 'error', message: 'HTTP 503' } }],
    });
    const quality = summarizeQuality(withGaps, [{ id: 'main', start: '2025-01-01', end: '2025-01-03' }], 'daily');
    const codes = qualityWarnings({ lang: 'uk', title: 'Астрономія', createdOn: '2020-01-01', granularity: 'daily' }, withGaps, quality).map((warning) => warning.code);
    expect(codes).toEqual(['PAGEVIEWS_API_ERROR', 'LOW_COVERAGE']);

    const quality2 = summarizeQuality(observations, [{ id: 'main', start: '2025-01-01', end: '2026-01-10' }], 'daily');
    const codes2 = qualityWarnings({ lang: 'uk', title: 'X', createdOn: '2025-01-02', granularity: 'daily' }, observations, quality2).map((warning) => warning.code);
    expect(codes2).toEqual(['INCOMPLETE_PERIOD_EXCLUDED', 'BEFORE_ARTICLE_CREATION', 'ZERO_VIEWS_INFERRED']);
  });

  it('deduplicates identical warnings from several languages', () => {
    const warning = { code: 'INCOMPLETE_PERIOD_EXCLUDED', message: 'same' };
    expect(dedupeWarnings([warning, { ...warning }, { ...warning, language: 'uk' }])).toHaveLength(2);
  });
});
