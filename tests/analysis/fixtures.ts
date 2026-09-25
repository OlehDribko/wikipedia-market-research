import { enumerateDays, enumerateMonths } from '../../src/periods/dates.ts';
import type { Observation } from '../../src/schemas/observation.ts';
import type { Dataset } from '../../src/schemas/research.ts';

export function observed(period: string, views: number): Observation {
  return { period, views, status: 'observed', certainty: 'established', reason: 'fixture' };
}

export function inferredZero(period: string): Observation {
  return { period, views: 0, status: 'zero_omitted', certainty: 'uncertain', reason: 'fixture' };
}

export function missing(period: string, status: 'unavailable' | 'api_error' | 'incomplete' | 'before_creation' = 'unavailable'): Observation {
  return { period, views: null, status, certainty: 'established', reason: 'fixture' };
}

/** Daily observations from `start`, one per value; null → unavailable. */
export function dailySeries(start: string, values: readonly (number | null)[]): Observation[] {
  const end = new Date(Date.parse(`${start}T00:00:00Z`) + (values.length - 1) * 86_400_000).toISOString().slice(0, 10);
  return enumerateDays({ start, end }).map((day, index) => {
    const value = values[index];
    return value === null || value === undefined ? missing(day) : observed(day, value);
  });
}

/** Monthly observations from `startMonth` (YYYY-MM-01). */
export function monthlySeries(startMonth: string, values: readonly (number | null)[]): Observation[] {
  const months: string[] = [];
  for (const month of enumerateMonths({ start: startMonth, end: `${Number(startMonth.slice(0, 4)) + 20}-12-31` })) {
    if (months.length === values.length) break;
    months.push(month);
  }
  return months.map((month, index) => {
    const value = values[index];
    return value === null || value === undefined ? missing(month) : observed(month, value);
  });
}

export function dataset(lang: string, granularity: 'daily' | 'monthly', observations: Observation[], overrides: Partial<Dataset> = {}): Dataset {
  return {
    lang,
    project: `${lang}.wikipedia`,
    title: `Title ${lang}`,
    pageId: 1,
    url: `https://${lang}.wikipedia.org/wiki/Title`,
    wikidataId: 'Q333',
    createdAt: '2001-01-01T00:00:00Z',
    creationSource: 'mediawiki_first_revision',
    granularity,
    agent: 'user',
    access: 'all-access',
    publishedThrough: '2026-01-09',
    requests: [],
    observations,
    quality: { counts: { observed: 0, zero_omitted: 0, before_creation: 0, unavailable: 0, incomplete: 0, api_error: 0 }, uncertain: 0, byPeriod: [] },
    ...overrides,
  };
}

/** Deterministic pseudo-noise in [-1, 1] (no Math.random). */
export function noise(index: number): number {
  return Math.sin(index * 12.9898) * 0.5 + Math.sin(index * 78.233) * 0.5;
}
