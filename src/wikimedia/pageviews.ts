import { z } from 'zod';
import { addDays, fromApiTimestamp, monthEnd, toCompactDate, type DateRange } from '../periods/dates.ts';
import type { FetchGranularity } from '../periods/plan.ts';
import { parseResponse, WikimediaApiError, type JsonClient } from './http.ts';

export const PAGEVIEWS_API = 'https://wikimedia.org/api/rest_v1/metrics/pageviews';
/** First day for which the pageviews API serves data. */
export const PAGEVIEWS_DATA_START = '2015-07-01';
export const PAGEVIEWS_AGENT = 'user';
export const PAGEVIEWS_ACCESS = 'all-access';

export interface PageviewRow {
  /** Unit start: the day, or the first day of the month. */
  date: string;
  views: number;
}

/**
 * Raw outcome of one per-article request. `no_data` is an HTTP 404, which Wikimedia returns
 * both for "no views in the range" and for "data not loaded"; it is never interpreted as zero here.
 */
export type ArticlePageviews = { kind: 'ok'; rows: PageviewRow[] } | { kind: 'no_data'; httpStatus: 404 };

export const ArticlePageviewsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ok'), rows: z.array(z.object({ date: z.iso.date(), views: z.number().int().nonnegative() })) }),
  z.object({ kind: z.literal('no_data'), httpStatus: z.literal(404) }),
]);

export interface ArticlePageviewsRequest extends DateRange {
  /** Wikimedia project, e.g. "uk.wikipedia". */
  project: string;
  /** Canonical article title (spaces or underscores). */
  title: string;
  granularity: FetchGranularity;
}

const ItemSchema = z.object({
  project: z.string(),
  article: z.string().optional(),
  granularity: z.string(),
  timestamp: z.string(),
  access: z.string(),
  agent: z.string(),
  views: z.number().int().nonnegative(),
});
const ItemsResponseSchema = z.object({ items: z.array(ItemSchema) });

export function projectFor(lang: string): string {
  return `${lang}.wikipedia`;
}

/** Title as used in the API path: underscores for spaces, fully percent-encoded (including "/"). */
export function encodeArticle(title: string): string {
  return encodeURIComponent(title.replaceAll(' ', '_'));
}

export function articlePageviewsUrl(request: ArticlePageviewsRequest): string {
  return [
    PAGEVIEWS_API,
    'per-article',
    request.project,
    PAGEVIEWS_ACCESS,
    PAGEVIEWS_AGENT,
    encodeArticle(request.title),
    request.granularity,
    toCompactDate(request.start),
    toCompactDate(request.end),
  ].join('/');
}

function assertMonthly(request: { granularity: FetchGranularity } & DateRange, url: string): void {
  // The API silently sums partial months when bounds are not month-aligned; never request that.
  if (request.granularity === 'monthly' && (!request.start.endsWith('-01') || monthEnd(request.end) !== request.end)) {
    throw new WikimediaApiError('unexpected_response', `Monthly requests must cover whole months (${request.start}..${request.end}).`, url);
  }
}

/** Parses items and checks that every row belongs to the request (project, filters, granularity, range). */
function parseItems(
  data: unknown,
  url: string,
  expected: { project: string; granularity: FetchGranularity; article?: string } & DateRange,
): PageviewRow[] {
  const { items } = parseResponse(ItemsResponseSchema, data, url);
  const rows = new Map<string, number>();

  for (const item of items) {
    const date = fromApiTimestamp(item.timestamp);
    const mismatch =
      item.project !== expected.project ||
      item.granularity !== expected.granularity ||
      item.access !== PAGEVIEWS_ACCESS ||
      item.agent !== PAGEVIEWS_AGENT ||
      (expected.article !== undefined && item.article !== expected.article);
    if (date === null || mismatch || date < expected.start || date > expected.end || rows.has(date)) {
      throw new WikimediaApiError('unexpected_response', `Pageviews response from ${url} contains an unexpected item: ${JSON.stringify(item)}.`, url, 200);
    }
    if (expected.granularity === 'monthly' && !date.endsWith('-01')) {
      throw new WikimediaApiError('unexpected_response', `Monthly item not aligned to a month start in ${url}.`, url, 200);
    }
    rows.set(date, item.views);
  }
  return [...rows].map(([date, views]) => ({ date, views })).sort((a, b) => a.date.localeCompare(b.date));
}

/** Fetches per-article pageviews (agent=user, access=all-access). Throws WikimediaApiError on failure. */
export async function fetchArticlePageviews(api: JsonClient, request: ArticlePageviewsRequest): Promise<ArticlePageviews> {
  const url = articlePageviewsUrl(request);
  assertMonthly(request, url);
  let data: Record<string, unknown>;
  try {
    data = await api.getJson(url, {});
  } catch (error) {
    if (error instanceof WikimediaApiError && error.kind === 'http' && error.status === 404) return { kind: 'no_data', httpStatus: 404 };
    throw error;
  }
  const article = request.title.replaceAll(' ', '_');
  return { kind: 'ok', rows: parseItems(data, url, { ...request, article }) };
}

export function aggregatePageviewsUrl(project: string, granularity: FetchGranularity, range: DateRange): string {
  return [PAGEVIEWS_API, 'aggregate', project, PAGEVIEWS_ACCESS, PAGEVIEWS_AGENT, granularity, toCompactDate(range.start), toCompactDate(range.end)].join('/');
}

/**
 * Latest day covered by published data for a whole project within `window`.
 * A project always has views, so the last aggregate row marks the publication horizon; this separates
 * "not yet published" from "no views" for individual articles. Returns the day before the window
 * when nothing in it is published yet.
 */
export async function fetchPublishedThrough(
  api: JsonClient,
  project: string,
  granularity: FetchGranularity,
  window: DateRange,
): Promise<string> {
  const url = aggregatePageviewsUrl(project, granularity, window);
  assertMonthly({ granularity, ...window }, url);
  let data: Record<string, unknown>;
  try {
    data = await api.getJson(url, {});
  } catch (error) {
    if (error instanceof WikimediaApiError && error.kind === 'http' && error.status === 404) return addDays(window.start, -1);
    throw error;
  }
  const rows = parseItems(data, url, { project, granularity, ...window });
  const last = rows.at(-1);
  if (!last) return addDays(window.start, -1);
  return granularity === 'daily' ? last.date : monthEnd(last.date);
}
