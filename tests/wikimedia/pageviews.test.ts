import { describe, expect, it } from 'vitest';
import { createJsonClient, type HttpRequest, type HttpResponse } from '../../src/wikimedia/http.ts';
import { fetchFirstRevisionTimestamp } from '../../src/wikimedia/mediawiki.ts';
import { articlePageviewsUrl, encodeArticle, fetchArticlePageviews, fetchPublishedThrough } from '../../src/wikimedia/pageviews.ts';
import { createFakeWikimedia } from '../helpers/fakeWikimedia.ts';

function item(timestamp: string, views: number, overrides: Record<string, unknown> = {}) {
  return { project: 'pl.wikipedia', article: 'Astronomia', granularity: 'daily', timestamp, access: 'all-access', agent: 'user', views, ...overrides };
}

function scripted(responses: HttpResponse[]) {
  const calls: HttpRequest[] = [];
  const delays: number[] = [];
  let index = 0;
  const api = createJsonClient({
    transport: async (request) => {
      calls.push(request);
      return responses[Math.min(index++, responses.length - 1)] as HttpResponse;
    },
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { api, calls, delays };
}

const daily = { project: 'pl.wikipedia', title: 'Astronomia', granularity: 'daily' as const, start: '2025-01-01', end: '2025-01-03' };

describe('pageviews URLs', () => {
  it('uses agent=user and access=all-access with compact dates', () => {
    expect(articlePageviewsUrl(daily)).toBe(
      'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/pl.wikipedia/all-access/user/Astronomia/daily/20250101/20250103',
    );
  });

  it('encodes Unicode titles, spaces and slashes', () => {
    expect(encodeArticle('Астрономія')).toBe('%D0%90%D1%81%D1%82%D1%80%D0%BE%D0%BD%D0%BE%D0%BC%D1%96%D1%8F');
    expect(encodeArticle('Post przerywany')).toBe('Post_przerywany');
    expect(encodeArticle('AC/DC')).toBe('AC%2FDC');
    expect(encodeArticle('Łódź?')).toBe('%C5%81%C3%B3d%C5%BA%3F');
  });
});

describe('fetchArticlePageviews', () => {
  it('parses daily rows and keeps explicit zero rows', async () => {
    const { api } = scripted([{ status: 200, data: { items: [item('2025010300', 7), item('2025010100', 0)] } }]);
    expect(await fetchArticlePageviews(api, daily)).toEqual({
      kind: 'ok',
      rows: [
        { date: '2025-01-01', views: 0 },
        { date: '2025-01-03', views: 7 },
      ],
    });
  });

  it('parses monthly rows for whole-month requests', async () => {
    const monthly = { ...daily, granularity: 'monthly' as const, start: '2025-01-01', end: '2025-02-28' };
    const { api } = scripted([
      { status: 200, data: { items: [item('2025010100', 2194, { granularity: 'monthly' }), item('2025020100', 1896, { granularity: 'monthly' })] } },
    ]);
    expect(await fetchArticlePageviews(api, monthly)).toEqual({
      kind: 'ok',
      rows: [
        { date: '2025-01-01', views: 2194 },
        { date: '2025-02-01', views: 1896 },
      ],
    });
  });

  it('refuses monthly requests that are not month-aligned, which the API would sum partially', async () => {
    const { api, calls } = scripted([{ status: 200, data: { items: [] } }]);
    await expect(fetchArticlePageviews(api, { ...daily, granularity: 'monthly', start: '2025-01-15', end: '2025-01-31' })).rejects.toMatchObject({
      kind: 'unexpected_response',
    });
    expect(calls).toHaveLength(0);
  });

  it('reports HTTP 404 as no_data, not as zero views', async () => {
    const { api, calls } = scripted([{ status: 404, data: { title: 'Not Found' } }]);
    expect(await fetchArticlePageviews(api, daily)).toEqual({ kind: 'no_data', httpStatus: 404 });
    expect(calls).toHaveLength(1);
  });

  it('retries HTTP 429 honouring Retry-After, then succeeds', async () => {
    const { api, calls, delays } = scripted([
      { status: 429, data: '', retryAfter: '1' },
      { status: 200, data: { items: [item('2025010100', 5)] } },
    ]);
    expect(await fetchArticlePageviews(api, daily)).toEqual({ kind: 'ok', rows: [{ date: '2025-01-01', views: 5 }] });
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([1000]);
  });

  it('gives up on persistent 429 with a rate_limited error', async () => {
    const { api, calls } = scripted([{ status: 429, data: '' }]);
    await expect(fetchArticlePageviews(api, daily)).rejects.toMatchObject({ kind: 'rate_limited', status: 429 });
    expect(calls).toHaveLength(3);
  });

  it.each([
    ['no items array', { detail: 'x' }],
    ['negative views', { items: [item('2025010100', -1)] }],
    ['wrong project', { items: [item('2025010100', 1, { project: 'en.wikipedia' })] }],
    ['wrong agent', { items: [item('2025010100', 1, { agent: 'all-agents' })] }],
    ['wrong article', { items: [item('2025010100', 1, { article: 'Astronomy' })] }],
    ['wrong granularity', { items: [item('2025010100', 1, { granularity: 'monthly' })] }],
    ['date outside the range', { items: [item('2025010400', 1)] }],
    ['duplicate date', { items: [item('2025010100', 1), item('2025010100', 2)] }],
    ['malformed timestamp', { items: [item('20250101', 1)] }],
  ])('rejects invalid responses: %s', async (_label, data) => {
    const { api } = scripted([{ status: 200, data }]);
    await expect(fetchArticlePageviews(api, daily)).rejects.toMatchObject({ kind: 'unexpected_response' });
  });

  it('round-trips Unicode titles through the fake API', async () => {
    const { transport, calls } = createFakeWikimedia({
      wikis: {},
      pageviews: { 'uk.wikipedia': { 'Астрономія': { '2025-01-01': 10, '2025-01-02': 12 } } },
    });
    const api = createJsonClient({ transport });
    const result = await fetchArticlePageviews(api, { ...daily, project: 'uk.wikipedia', title: 'Астрономія' });
    expect(result).toEqual({ kind: 'ok', rows: [{ date: '2025-01-01', views: 10 }, { date: '2025-01-02', views: 12 }] });
    expect(calls[0]?.url).toContain('/%D0%90%D1%81%D1%82%D1%80%D0%BE%D0%BD%D0%BE%D0%BC%D1%96%D1%8F/');
  });
});

describe('fetchPublishedThrough', () => {
  const window = { start: '2026-09-11', end: '2026-09-24' };

  it('returns the last published day of the project', async () => {
    const { transport } = createFakeWikimedia({ wikis: {}, publishedThrough: '2026-09-22' });
    expect(await fetchPublishedThrough(createJsonClient({ transport }), 'pl.wikipedia', 'daily', window)).toBe('2026-09-22');
  });

  it('returns the day before the window when nothing is published', async () => {
    const { transport } = createFakeWikimedia({ wikis: {}, publishedThrough: '2026-09-01' });
    expect(await fetchPublishedThrough(createJsonClient({ transport }), 'pl.wikipedia', 'daily', window)).toBe('2026-09-10');
  });

  it('returns a month end for monthly data', async () => {
    const { transport } = createFakeWikimedia({ wikis: {}, publishedThrough: '2026-09-24' });
    const api = createJsonClient({ transport });
    expect(await fetchPublishedThrough(api, 'pl.wikipedia', 'monthly', { start: '2026-06-01', end: '2026-08-31' })).toBe('2026-08-31');
  });
});

describe('fetchFirstRevisionTimestamp', () => {
  const edition = { code: 'uk', url: 'https://uk.wikipedia.org' };
  const wikis = { uk: { pages: [{ title: 'Астрономія', pageid: 827, created: '2004-02-26T16:27:52Z' }, { title: 'Без історії', pageid: 5 }] } };

  it('returns the first revision timestamp', async () => {
    const { transport, calls } = createFakeWikimedia({ wikis });
    expect(await fetchFirstRevisionTimestamp(createJsonClient({ transport }), edition, 827)).toBe('2004-02-26T16:27:52Z');
    expect(calls[0]?.params).toMatchObject({ prop: 'revisions', rvdir: 'newer', rvlimit: '1', pageids: '827' });
  });

  it('returns null for missing pages or pages without revisions', async () => {
    const { transport } = createFakeWikimedia({ wikis });
    const api = createJsonClient({ transport });
    expect(await fetchFirstRevisionTimestamp(api, edition, 999)).toBeNull();
    expect(await fetchFirstRevisionTimestamp(api, edition, 5)).toBeNull();
  });
});
