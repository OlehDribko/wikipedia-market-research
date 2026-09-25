import { z } from 'zod';
import type { FileCache, CacheKeyParts } from '../cache/fileCache.ts';
import { addDays, addMonths, type DateRange } from '../periods/dates.ts';
import { completeCeiling, unitEnd, unitsFor, type FetchGranularity, type PeriodPlan } from '../periods/plan.ts';
import { classifyObservations, type FetchedChunk } from '../quality/classify.ts';
import { qualityWarnings, summarizeQuality } from '../quality/summary.ts';
import type { Warning } from '../schemas/envelope.ts';
import type { Dataset } from '../schemas/research.ts';
import type { LanguageArticle } from '../schemas/resolve.ts';
import { WikimediaApiError, type JsonClient } from '../wikimedia/http.ts';
import { fetchFirstRevisionTimestamp } from '../wikimedia/mediawiki.ts';
import {
  aggregatePageviewsUrl,
  ArticlePageviewsSchema,
  articlePageviewsUrl,
  fetchArticlePageviews,
  fetchPublishedThrough,
  PAGEVIEWS_ACCESS,
  PAGEVIEWS_AGENT,
  PAGEVIEWS_DATA_START,
  projectFor,
} from '../wikimedia/pageviews.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Pageview data older than this is treated as settled. */
const HISTORICAL_AGE_DAYS = 45;
export const CACHE_TTL = {
  historicalPageviews: 30 * DAY,
  recentPageviews: 6 * HOUR,
  articleMetadata: 7 * DAY,
  publicationHorizon: 1 * HOUR,
} as const;

export interface CacheStats {
  hits: number;
  misses: number;
  bypassed: number;
  writeFailures: number;
}

export interface CollectContext {
  api: JsonClient;
  /** null disables caching entirely. */
  cache: FileCache | null;
  /** false (--no-cache) skips cache reads; fresh responses are still written. */
  readCache: boolean;
  now: () => Date;
  stats: CacheStats;
  /** Non-fatal problems such as cache write failures. */
  warnings: Warning[];
  horizons: Map<string, Promise<string>>;
}

export function createCollectContext(options: Pick<CollectContext, 'api' | 'cache' | 'readCache' | 'now'>): CollectContext {
  return { ...options, stats: { hits: 0, misses: 0, bypassed: 0, writeFailures: 0 }, warnings: [], horizons: new Map() };
}

type CacheStatus = 'hit' | 'miss' | 'bypass' | 'none';

async function cached<S extends z.ZodType>(
  context: CollectContext,
  entry: {
    namespace: string;
    parts: CacheKeyParts;
    schema: S;
    source: string;
    ttlMs: (value: z.output<S>) => number;
    meta?: (value: z.output<S>) => Record<string, string | number>;
  },
  fetch: () => Promise<z.output<S>>,
): Promise<{ value: z.output<S>; cache: CacheStatus; fetchedAt: string }> {
  const { cache } = context;
  if (cache && context.readCache) {
    const hit = await cache.get(entry.namespace, entry.parts, entry.schema);
    if (hit) {
      context.stats.hits++;
      return { value: hit.value, cache: 'hit', fetchedAt: hit.fetchedAt };
    }
  }

  const fetchedAt = context.now();
  const value = await fetch();
  let status: CacheStatus = 'none';
  if (cache) {
    status = context.readCache ? 'miss' : 'bypass';
    context.stats[context.readCache ? 'misses' : 'bypassed']++;
    try {
      await cache.set(entry.namespace, entry.parts, value, {
        ttlMs: entry.ttlMs(value),
        source: entry.source,
        fetchedAt,
        ...(entry.meta && { meta: entry.meta(value) }),
      });
    } catch (error) {
      context.stats.writeFailures++;
      if (context.stats.writeFailures === 1) {
        context.warnings.push({
          code: 'CACHE_WRITE_FAILED',
          message: `Could not write to the cache (${error instanceof Error ? error.message : String(error)}). Results are unaffected.`,
        });
      }
    }
  }
  return { value, cache: status, fetchedAt: fetchedAt.toISOString() };
}

/** Calendar-year request windows covering the fetchable units, clipped to data availability and completeness. */
export function planChunks(fetchableUnits: readonly string[], ceiling: string): DateRange[] {
  const years = [...new Set(fetchableUnits.map((unit) => unit.slice(0, 4)))];
  return years.map((year) => {
    const start = `${year}-01-01` < PAGEVIEWS_DATA_START ? PAGEVIEWS_DATA_START : `${year}-01-01`;
    const end = `${year}-12-31` > ceiling ? ceiling : `${year}-12-31`;
    return { start, end };
  });
}

/** Last day of published project data, probed only when the requested units reach recent dates. */
async function publishedThrough(context: CollectContext, project: string, granularity: FetchGranularity, ceiling: string, lastUnitEnd: string | null): Promise<string> {
  const window: DateRange =
    granularity === 'daily'
      ? { start: addDays(ceiling, -13), end: ceiling }
      : { start: addMonths(ceiling, -2), end: ceiling };
  if (lastUnitEnd === null || lastUnitEnd < window.start) return ceiling;

  const key = `${project}|${granularity}|${window.start}|${window.end}`;
  let horizon = context.horizons.get(key);
  if (!horizon) {
    horizon = cached(
      context,
      {
        namespace: 'publication-horizon',
        parts: { project, granularity, start: window.start, end: window.end, agent: PAGEVIEWS_AGENT, access: PAGEVIEWS_ACCESS },
        schema: z.iso.date(),
        source: aggregatePageviewsUrl(project, granularity, window),
        ttlMs: () => CACHE_TTL.publicationHorizon,
      },
      () => fetchPublishedThrough(context.api, project, granularity, window),
    ).then((result) => result.value);
    context.horizons.set(key, horizon);
  }
  return horizon;
}

/** Retrieves, classifies and summarizes pageviews for one verified article. */
export async function collectDataset(
  context: CollectContext,
  article: LanguageArticle & { title: string; pageId: number; url: string },
  plan: PeriodPlan,
): Promise<{ dataset: Dataset; warnings: Warning[] }> {
  const { granularity, today } = plan;
  const project = projectFor(article.lang);
  const edition = { code: article.lang, url: article.edition.url };

  let createdAt: string | null = null;
  try {
    const result = await cached(
      context,
      {
        namespace: 'first-revision',
        parts: { project, pageId: String(article.pageId) },
        schema: z.iso.datetime().nullable(),
        source: `${edition.url}/w/api.php`,
        ttlMs: () => CACHE_TTL.articleMetadata,
      },
      () => fetchFirstRevisionTimestamp(context.api, edition, article.pageId),
    );
    createdAt = result.value;
  } catch (error) {
    if (!(error instanceof WikimediaApiError)) throw error;
  }
  const createdOn = createdAt?.slice(0, 10) ?? null;

  const units = unitsFor(plan.periods, granularity);
  const ceiling = completeCeiling(today, granularity);
  const fetchable = units.filter((unit) => unit >= PAGEVIEWS_DATA_START && unitEnd(unit, granularity) <= ceiling);

  const chunks: FetchedChunk[] = [];
  const requests: Dataset['requests'] = [];
  for (const range of planChunks(fetchable, ceiling)) {
    const request = { project, title: article.title, granularity, ...range };
    const url = articlePageviewsUrl(request);

    if (createdOn !== null && range.end < createdOn) {
      chunks.push({ ...range, outcome: { kind: 'skipped_before_creation' } });
      requests.push({ ...range, url, outcome: 'skipped_before_creation', rows: null, cache: 'none', fetchedAt: null, error: null });
      continue;
    }

    try {
      const historical = range.end < addDays(today, -HISTORICAL_AGE_DAYS);
      const result = await cached(
        context,
        {
          namespace: 'pageviews',
          parts: {
            project,
            article: article.title.replaceAll(' ', '_'),
            granularity,
            start: range.start,
            end: range.end,
            agent: PAGEVIEWS_AGENT,
            access: PAGEVIEWS_ACCESS,
          },
          schema: ArticlePageviewsSchema,
          source: url,
          ttlMs: () => (historical ? CACHE_TTL.historicalPageviews : CACHE_TTL.recentPageviews),
          meta: (value) => ({ outcome: value.kind, observations: value.kind === 'ok' ? value.rows.length : 0 }),
        },
        () => fetchArticlePageviews(context.api, request),
      );
      const { value } = result;
      chunks.push({
        ...range,
        outcome: value.kind === 'ok' ? { kind: 'ok', rows: new Map(value.rows.map((row) => [row.date, row.views])) } : { kind: 'no_data' },
      });
      requests.push({
        ...range,
        url,
        outcome: value.kind,
        rows: value.kind === 'ok' ? value.rows.length : null,
        cache: result.cache,
        fetchedAt: result.fetchedAt,
        error: null,
      });
    } catch (error) {
      if (!(error instanceof WikimediaApiError)) throw error;
      chunks.push({ ...range, outcome: { kind: 'error', message: error.message } });
      requests.push({ ...range, url, outcome: 'error', rows: null, cache: 'none', fetchedAt: null, error: error.message });
    }
  }

  const lastFetchable = fetchable.at(-1);
  const horizon = await publishedThrough(context, project, granularity, ceiling, lastFetchable ? unitEnd(lastFetchable, granularity) : null);
  const observations = classifyObservations({ units, granularity, today, publishedThrough: horizon, createdOn, chunks });
  const quality = summarizeQuality(observations, plan.periods, granularity);

  const dataset: Dataset = {
    lang: article.lang,
    project,
    title: article.title,
    pageId: article.pageId,
    url: article.url,
    wikidataId: article.wikidataId,
    createdAt,
    creationSource: createdAt === null ? 'unknown' : 'mediawiki_first_revision',
    granularity,
    agent: PAGEVIEWS_AGENT,
    access: PAGEVIEWS_ACCESS,
    publishedThrough: horizon,
    requests,
    observations,
    quality,
  };
  return { dataset, warnings: qualityWarnings({ lang: article.lang, title: article.title, createdOn, granularity }, observations, quality) };
}
