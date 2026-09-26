import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCache } from '../../src/cache/fileCache.ts';
import { ResearchResolutionError, runResearch } from '../../src/research/research.ts';
import { ResearchInputSchema } from '../../src/schemas/inputs.ts';
import { ResearchArtifactSchema } from '../../src/schemas/research.ts';
import { createJsonClient, type HttpRequest, type HttpResponse } from '../../src/wikimedia/http.ts';
import { createFakeWikimedia, type FakePageviews, type FakeWiki } from '../helpers/fakeWikimedia.ts';

const NOW = new Date('2026-01-10T12:00:00Z');
const DAY_MS = 86_400_000;

/** Deterministic daily views; `skip` days are omitted like zero-traffic days in the real API. */
function series(start: string, end: string, base: number, skip: string[] = []): Record<string, number> {
  const days: Record<string, number> = {};
  for (let time = Date.parse(`${start}T00:00:00Z`); time <= Date.parse(`${end}T00:00:00Z`); time += DAY_MS) {
    const day = new Date(time).toISOString().slice(0, 10);
    if (!skip.includes(day)) days[day] = base + Number(day.slice(8, 10));
  }
  return days;
}

const WIKIS: Record<string, FakeWiki> = {
  en: {
    pages: [
      { title: 'Astronomy', pageid: 1, wikidata: 'Q333', created: '2001-11-01T00:00:00Z', langlinks: { uk: 'Астрономія', pl: 'Astronomia', de: 'Astronomie' } },
      { title: 'ChatGPT', pageid: 2, wikidata: 'Q115564437', created: '2022-12-05T00:11:07Z', langlinks: { uk: 'ChatGPT' } },
      { title: 'Mercury', pageid: 3, disambiguation: true },
      { title: 'Mercury (planet)', pageid: 4 },
      { title: 'Veganuary', pageid: 5, created: '2015-01-01T00:00:00Z' },
    ],
    search: { Mercury: ['Mercury', 'Mercury (planet)'] },
  },
  uk: {
    pages: [
      { title: 'Астрономія', pageid: 827, wikidata: 'Q333', created: '2004-02-26T16:27:52Z' },
      { title: 'ChatGPT', pageid: 900, wikidata: 'Q115564437', created: '2022-12-14T09:00:00Z' },
    ],
  },
  pl: { pages: [{ title: 'Astronomia', pageid: 2221092, wikidata: 'Q333', created: '2002-09-13T22:14:35Z' }] },
  de: { pages: [{ title: 'Astronomie', pageid: 300, wikidata: 'Q333', created: '2002-01-01T00:00:00Z' }] },
};

const PAGEVIEWS: FakePageviews = {
  'uk.wikipedia': {
    'Астрономія': series('2024-01-01', '2026-01-09', 100, ['2025-03-05']),
    ChatGPT: series('2022-12-14', '2026-01-09', 50),
  },
  'pl.wikipedia': { Astronomia: series('2024-01-01', '2026-01-09', 200) },
  'en.wikipedia': { ChatGPT: series('2022-12-05', '2026-01-09', 1000) },
  // de.wikipedia has no data at all → HTTP 404
};

let dir: string;
let now: Date;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wmr-research-'));
  now = NOW;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(options: { override?: (request: HttpRequest) => HttpResponse | undefined; publishedThrough?: string; cache?: boolean } = {}) {
  const fake = createFakeWikimedia({
    wikis: WIKIS,
    pageviews: PAGEVIEWS,
    publishedThrough: options.publishedThrough ?? '2026-01-09',
    ...(options.override && { override: options.override }),
  });
  const api = createJsonClient({ transport: fake.transport, sleep: async () => {} });
  const cache = options.cache === false ? null : new FileCache({ dir: join(dir, 'cache'), now: () => now });
  const run = (flags: Record<string, unknown>) =>
    runResearch(ResearchInputSchema.parse({ out: join(dir, 'out'), ...flags }), { api, cache, now: () => now });
  const pageviewCalls = () => fake.calls.filter((call) => call.url.includes('/per-article/'));
  return { ...fake, run, pageviewCalls };
}

function dataset(outcome: Awaited<ReturnType<ReturnType<typeof setup>['run']>>, lang: string) {
  const found = outcome.artifact.datasets.find((candidate) => candidate.lang === lang);
  if (!found) throw new Error(`No dataset for ${lang}`);
  return found;
}

function codes(outcome: { warnings: { code: string; language?: string | undefined }[] }) {
  return outcome.warnings.map((warning) => (warning.language ? `${warning.code}:${warning.language}` : warning.code));
}

describe('research: pageview retrieval', () => {
  it('collects monthly data for the default period across languages and saves a valid artifact', async () => {
    const { run } = setup();
    const outcome = await run({ topic: 'Astronomy', lang: 'en', langs: 'uk,pl' });

    expect(outcome.summary.periodMode).toBe('default');
    expect(outcome.summary.periods).toEqual([{ id: 'main', start: '2025-01-01', end: '2025-12-31' }]);
    expect(outcome.summary.granularity.selected).toBe('monthly');
    expect(outcome.summary.nextStep).toContain('last 12 completed calendar months (2025-01-01 to 2025-12-31)');

    const uk = dataset(outcome, 'uk');
    expect(uk).toMatchObject({ project: 'uk.wikipedia', title: 'Астрономія', pageId: 827, agent: 'user', access: 'all-access', granularity: 'monthly' });
    expect(uk.observations).toHaveLength(12);
    expect(uk.observations.every((observation) => observation.status === 'observed')).toBe(true);
    // Monthly value = sum of the daily fake values for January 2025 (100 + day number).
    expect(uk.observations[0]).toMatchObject({ period: '2025-01-01', views: 31 * 100 + (31 * 32) / 2 });
    expect(dataset(outcome, 'pl').title).toBe('Astronomia');

    const saved = ResearchArtifactSchema.parse(JSON.parse(await readFile(outcome.summary.artifactPath, 'utf8')));
    expect(saved).toEqual(outcome.artifact);
    expect(saved.analysis.languages.map((language) => language.lang)).toEqual(['uk', 'pl']);
  });

  it('keeps observations out of the compact summary', async () => {
    const { run } = setup();
    const outcome = await run({ article: 'en:Astronomy', langs: 'uk,pl', start: '2025-01-01', end: '2025-12-31', granularity: 'daily' });
    expect(dataset(outcome, 'uk').observations).toHaveLength(365);
    const summaryJson = JSON.stringify(outcome.summary);
    expect(summaryJson).not.toContain('"observations"');
    expect(summaryJson.length).toBeLessThan(3000);
    expect(outcome.summary.languages[0]).toMatchObject({ lang: 'uk', units: 365 });
  });

  it('uses exact daily data for non-calendar-month ranges with inclusive bounds and Unicode titles', async () => {
    const { run, pageviewCalls } = setup();
    const outcome = await run({ article: 'en:Astronomy', langs: 'uk', start: '2025-03-01', end: '2025-03-10' });

    const uk = dataset(outcome, 'uk');
    expect(outcome.summary.granularity.selected).toBe('daily');
    expect(uk.observations.map((observation) => observation.period)).toEqual([
      '2025-03-01', '2025-03-02', '2025-03-03', '2025-03-04', '2025-03-05',
      '2025-03-06', '2025-03-07', '2025-03-08', '2025-03-09', '2025-03-10',
    ]);
    expect(uk.observations[4]).toMatchObject({ period: '2025-03-05', status: 'zero_omitted', views: 0, certainty: 'uncertain' });
    expect(pageviewCalls()[0]?.url).toContain('/uk.wikipedia/all-access/user/%D0%90%D1%81%D1%82%D1%80%D0%BE%D0%BD%D0%BE%D0%BC%D1%96%D1%8F/daily/20250101/20251231');
    expect(codes(outcome)).toContain('ZERO_VIEWS_INFERRED:uk');
    expect(uk.quality.byPeriod[0]).toMatchObject({ expected: 10, counted: 10, coverage: 1 });
  });

  it('reports HTTP 404 datasets as uncertain unavailable data, never as zero', async () => {
    const { run } = setup();
    const outcome = await run({ article: 'en:Astronomy', langs: 'de', start: '2025-01', end: '2025-03' });
    const de = dataset(outcome, 'de');
    expect(de.observations.map((observation) => [observation.status, observation.certainty, observation.views])).toEqual([
      ['unavailable', 'uncertain', null],
      ['unavailable', 'uncertain', null],
      ['unavailable', 'uncertain', null],
    ]);
    expect(de.requests[0]).toMatchObject({ outcome: 'no_data', rows: null });
    expect(codes(outcome)).toEqual(['PAGEVIEWS_NO_DATA:de', 'LOW_COVERAGE:de', 'TOTAL_NOT_CALCULATED:de']);
    expect(outcome.artifact.analysis.metrics['de.main.total']?.value).toBeNull();
  });

  it('uses article creation dates to mark earlier units and skips pre-creation requests', async () => {
    const { run, pageviewCalls } = setup();
    const outcome = await run({ article: 'en:ChatGPT', langs: 'en,uk', compare: '2021-12-01..2021-12-10,2022-12-01..2022-12-20' });

    expect(outcome.summary.periodMode).toBe('comparisons');
    expect(outcome.summary.periods.map((period) => period.id)).toEqual(['compare-1', 'compare-2']);

    const en = dataset(outcome, 'en');
    expect(en.createdAt).toBe('2022-12-05T00:11:07Z');
    const statusOf = (day: string) => en.observations.find((observation) => observation.period === day)?.status;
    expect(statusOf('2021-12-05')).toBe('before_creation');
    expect(statusOf('2022-12-04')).toBe('before_creation');
    expect(statusOf('2022-12-05')).toBe('observed');
    expect(en.requests.find((request) => request.start === '2021-01-01')).toMatchObject({ outcome: 'skipped_before_creation', cache: 'none' });
    expect(pageviewCalls().some((call) => call.url.includes('/20210101/'))).toBe(false);

    const uk = dataset(outcome, 'uk');
    expect(uk.quality.byPeriod[0]).toMatchObject({ periodId: 'compare-1', expected: 0, coverage: null });
    expect(codes(outcome)).toEqual([
      'BEFORE_ARTICLE_CREATION:en',
      'BEFORE_ARTICLE_CREATION:uk',
      'TOTAL_NOT_CALCULATED:en',
      'TOTAL_NOT_CALCULATED:uk',
      'UNEQUAL_PERIOD_LENGTH',
      'SEASONALITY_NOT_ALIGNED',
      'COMPARISON_NOT_POSSIBLE:en',
      'COMPARISON_NOT_POSSIBLE:uk',
    ]);
  });

  it('marks incomplete and not-yet-published days explicitly', async () => {
    const { run } = setup({ publishedThrough: '2026-01-08' });
    const outcome = await run({ article: 'en:Astronomy', langs: 'uk,pl', start: '2026-01-05', end: '2026-01-15' });

    const uk = dataset(outcome, 'uk');
    const byDay = Object.fromEntries(uk.observations.map((observation) => [observation.period, observation]));
    expect(byDay['2026-01-08']).toMatchObject({ status: 'observed' });
    expect(byDay['2026-01-09']).toMatchObject({ status: 'unavailable', certainty: 'established', views: null });
    expect(byDay['2026-01-10']).toMatchObject({ status: 'incomplete', views: null });
    expect(byDay['2026-01-15']).toMatchObject({ status: 'incomplete', views: null });
    expect(uk.publishedThrough).toBe('2026-01-08');
    // Clock-based warnings are shared by all languages and reported once.
    expect(codes(outcome).filter((code) => code === 'INCOMPLETE_PERIOD_EXCLUDED')).toHaveLength(1);
    expect(codes(outcome)).toContain('DATA_NOT_YET_PUBLISHED');
  });

  it('keeps warnings from resolution and quality in the envelope output and the artifact', async () => {
    const { run } = setup();
    const outcome = await run({ article: 'en:Veganuary', langs: 'en,uk', start: '2025-01', end: '2025-02' });
    expect(outcome.summary.unavailableLanguages).toEqual([{ lang: 'uk', status: 'missing', title: null }]);
    expect(codes(outcome)).toEqual(['LANGUAGE_ARTICLE_MISSING:uk', 'PAGEVIEWS_NO_DATA:en', 'LOW_COVERAGE:en', 'TOTAL_NOT_CALCULATED:en']);
    expect(outcome.artifact.warnings).toEqual(outcome.warnings);
    const saved = JSON.parse(await readFile(outcome.summary.artifactPath, 'utf8'));
    expect(saved.warnings).toEqual(outcome.warnings);
  });
});

describe('research: analysis output', () => {
  it('adds a compact digest whose values match the citable metric index in the artifact', async () => {
    const { run } = setup();
    const outcome = await run({ article: 'en:Astronomy', langs: 'uk,pl', compare: '2024-01..2024-06,2025-01..2025-06' });
    const { analysis } = outcome.summary;

    expect(analysis.periods.map((period) => `${period.lang}.${period.periodId}`)).toEqual(['uk.compare-1', 'uk.compare-2', 'pl.compare-1', 'pl.compare-2']);
    for (const period of analysis.periods) {
      const metrics = outcome.artifact.analysis.metrics;
      expect(metrics[`${period.lang}.${period.periodId}.total`]?.value).toBe(period.total);
      expect(metrics[`${period.lang}.${period.periodId}.averageDaily`]?.value).toBe(period.averageDaily);
      expect(metrics[`${period.lang}.${period.periodId}.trend.direction`]?.value).toBe(period.trend);
    }
    expect(analysis.comparisons.map((comparison) => `${comparison.lang}.${comparison.id}`)).toEqual([
      'uk.compare-1_vs_compare-2',
      'pl.compare-1_vs_compare-2',
    ]);
    const pl = analysis.comparisons[1];
    expect(outcome.artifact.analysis.metrics['pl.compare-1_vs_compare-2.percentChange']?.value).toBe(pl?.percentChange);
    // Jan–Jun 2024 has 182 days (leap year), Jan–Jun 2025 has 181: intensity is compared per day.
    expect(analysis.comparisons[0]).toMatchObject({ issues: ['UNEQUAL_DURATION'], primaryMeasure: 'averageDaily' });
    expect(JSON.stringify(outcome.summary)).not.toContain('"observations"');
    expect(JSON.stringify(outcome.summary).length).toBeLessThan(6000);
  });
});

describe('research: compact digest units', () => {
  it('labels monthly spikes as whole months (real Astronomy research file)', async () => {
    const { readFileSync } = await import('node:fs');
    const { digestAnalysis } = await import('../../src/research/research.ts');
    const artifact = ResearchArtifactSchema.parse(JSON.parse(readFileSync(new URL('../fixtures/research-astronomy-uk-pl-2024-vs-2025.json', import.meta.url), 'utf8')));
    const spikes = digestAnalysis(artifact.analysis, artifact.plan.granularity).topSpikes;
    expect(spikes.map((spike) => [spike.lang, spike.period, spike.views])).toEqual([
      ['pl', '2025-11', 3845],
      ['uk', '2024-09', 4687],
    ]);
    // The full research file keeps machine-readable ISO dates.
    expect(artifact.analysis.languages[1]?.periods[1]?.anomalies.anomalies[0]?.period).toBe('2025-11-01');
  });
});

describe('research: API failures', () => {
  it('retries HTTP 429 and still returns observed data', async () => {
    let throttled = 0;
    const { run, pageviewCalls } = setup({
      override: (request) => (request.url.includes('/per-article/') && throttled++ < 2 ? { status: 429, data: '', retryAfter: '0' } : undefined),
    });
    const outcome = await run({ article: 'en:Astronomy', langs: 'pl', start: '2025-01', end: '2025-02' });
    expect(dataset(outcome, 'pl').quality.counts.observed).toBe(2);
    expect(pageviewCalls()).toHaveLength(3);
  });

  it('records persistent failures as api_error for that language only', async () => {
    const { run } = setup({ override: (request) => (request.url.includes('/uk.wikipedia/') && request.url.includes('/per-article/') ? { status: 503, data: '' } : undefined) });
    const outcome = await run({ article: 'en:Astronomy', langs: 'uk,pl', start: '2025-01', end: '2025-02' });
    expect(dataset(outcome, 'uk').observations.map((observation) => observation.status)).toEqual(['api_error', 'api_error']);
    expect(dataset(outcome, 'uk').requests[0]).toMatchObject({ outcome: 'error', cache: 'none' });
    expect(dataset(outcome, 'pl').quality.counts.observed).toBe(2);
    expect(codes(outcome)).toEqual(['PAGEVIEWS_API_ERROR:uk', 'LOW_COVERAGE:uk', 'TOTAL_NOT_CALCULATED:uk']);
  });

  it('records invalid pageview responses as api_error and does not cache them', async () => {
    let broken = true;
    const { run } = setup({ override: (request) => (broken && request.url.includes('/per-article/') ? { status: 200, data: { items: 'oops' } } : undefined) });
    const first = await run({ article: 'en:Astronomy', langs: 'pl', start: '2025-01', end: '2025-02' });
    expect(dataset(first, 'pl').observations[0]?.status).toBe('api_error');
    expect(dataset(first, 'pl').requests[0]?.error).toContain('Unexpected response structure');

    broken = false;
    const second = await run({ article: 'en:Astronomy', langs: 'pl', start: '2025-01', end: '2025-02' });
    expect(dataset(second, 'pl').quality.counts.observed).toBe(2);
  });
});

describe('research: cache', () => {
  // A 2024 range is historical relative to NOW (2026-01-10): 30-day TTL and no publication probe.
  const flags = { article: 'en:Astronomy', langs: 'uk,pl', start: '2024-01', end: '2024-12' };

  it('misses first, then serves pageviews and metadata from the cache', async () => {
    const { run, pageviewCalls, calls } = setup();
    const first = await run(flags);
    expect(first.summary.cache).toMatchObject({ enabled: true, hits: 0, misses: 4 });
    expect(dataset(first, 'uk').requests[0]?.cache).toBe('miss');
    expect(pageviewCalls()).toHaveLength(2);

    const callsBefore = calls.length;
    const second = await run(flags);
    expect(second.summary.cache).toMatchObject({ hits: 4, misses: 0 });
    expect(dataset(second, 'uk').requests[0]).toMatchObject({ cache: 'hit', fetchedAt: NOW.toISOString() });
    expect(pageviewCalls()).toHaveLength(2);
    // Only article resolution is repeated; pageviews and creation dates come from the cache.
    expect(calls.slice(callsBefore).every((call) => !call.url.includes('/per-article/') && call.params.prop !== 'revisions')).toBe(true);
    expect(dataset(second, 'uk').observations).toEqual(dataset(first, 'uk').observations);
  });

  it('expires historical pageviews after 30 days and creation dates after 7 days', async () => {
    const { run, pageviewCalls } = setup();
    await run(flags);

    now = new Date(NOW.getTime() + 8 * DAY_MS);
    const afterWeek = await run(flags);
    expect(afterWeek.summary.cache).toMatchObject({ hits: 2, misses: 2 });
    expect(pageviewCalls()).toHaveLength(2);

    now = new Date(NOW.getTime() + 31 * DAY_MS);
    await run(flags);
    expect(pageviewCalls()).toHaveLength(4);
  });

  it('expires recent pageviews after 6 hours', async () => {
    const { run, pageviewCalls } = setup();
    const recent = { article: 'en:Astronomy', langs: 'pl', start: '2025-12-20', end: '2026-01-05' };
    await run(recent);
    const initial = pageviewCalls().length;

    now = new Date(NOW.getTime() + 5 * 3_600_000);
    await run(recent);
    // The 2025 chunk ends 10 days before "today", so it is recent too: nothing refetched yet.
    expect(pageviewCalls()).toHaveLength(initial);

    now = new Date(NOW.getTime() + 7 * 3_600_000);
    await run(recent);
    expect(pageviewCalls()).toHaveLength(initial * 2);
  });

  it('bypasses cache reads with --no-cache but refreshes the stored data', async () => {
    const { run, pageviewCalls } = setup();
    await run(flags);
    const bypassed = await run({ ...flags, 'no-cache': true });
    expect(bypassed.summary.cache).toMatchObject({ hits: 0, misses: 0, bypassed: 4 });
    expect(dataset(bypassed, 'uk').requests[0]?.cache).toBe('bypass');
    expect(pageviewCalls()).toHaveLength(4);

    const cachedAgain = await run(flags);
    expect(cachedAgain.summary.cache.hits).toBe(4);
  });

  it('never serves daily data for a monthly request over the same range', async () => {
    const { run, pageviewCalls } = setup();
    await run({ ...flags, granularity: 'daily' });
    const monthly = await run({ ...flags, granularity: 'monthly' });

    expect(pageviewCalls()).toHaveLength(4);
    expect(dataset(monthly, 'pl').requests[0]?.cache).toBe('miss');
    expect(dataset(monthly, 'pl').observations).toHaveLength(12);
    expect(dataset(monthly, 'pl').observations[0]).toMatchObject({ period: '2024-01-01', views: 31 * 200 + (31 * 32) / 2 });
  });

  it('works without a cache', async () => {
    const { run } = setup({ cache: false });
    const outcome = await run(flags);
    expect(outcome.summary.cache).toMatchObject({ enabled: false, hits: 0, misses: 0 });
    expect(dataset(outcome, 'uk').requests[0]?.cache).toBe('none');
  });
});

describe('research: resolution failures', () => {
  it.each([
    [{ topic: 'Mercury', lang: 'en', langs: 'uk' }, 'AMBIGUOUS_TOPIC'],
    [{ topic: 'Nothing like this', lang: 'en', langs: 'uk' }, 'TOPIC_NOT_FOUND'],
    [{ article: 'en:Nothing like this', langs: 'uk' }, 'ARTICLE_NOT_FOUND'],
    [{ article: 'en:Veganuary', langs: 'uk,pl' }, 'NO_VERIFIED_ARTICLES'],
  ])('%j → %s without fetching pageviews', async (flags, code) => {
    const { run, pageviewCalls } = setup();
    const error = await run(flags).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ResearchResolutionError);
    expect((error as ResearchResolutionError).code).toBe(code);
    expect(pageviewCalls()).toHaveLength(0);
  });
});
