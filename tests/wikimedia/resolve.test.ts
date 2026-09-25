import { describe, expect, it } from 'vitest';
import type { ResolveRequest } from '../../src/schemas/inputs.ts';
import { ResolveResultSchema } from '../../src/schemas/resolve.ts';
import { createJsonClient, WikimediaApiError, type HttpRequest } from '../../src/wikimedia/http.ts';
import { lookupTitle } from '../../src/wikimedia/mediawiki.ts';
import { InvalidLanguageError, resolveTopic } from '../../src/wikimedia/resolve.ts';
import { createFakeWikimedia, type FakeWiki, type FakeWikimediaOptions } from '../helpers/fakeWikimedia.ts';

const WIKIS: Record<string, FakeWiki> = {
  en: {
    pages: [
      {
        title: 'Astronomy',
        pageid: 50650,
        wikidata: 'Q333',
        description: 'Scientific study of celestial objects',
        langlinks: { uk: 'Астрономія', pl: 'Astronomia', de: 'Astronomie', als: 'Astronomii' },
      },
      { title: 'Amateur astronomy', pageid: 1001, wikidata: 'Q1', description: 'Hobby' },
      { title: 'History of astronomy', pageid: 14021, wikidata: 'Q2', description: '' },
      { title: 'Mercury', pageid: 19007, wikidata: 'Q48397', disambiguation: true, description: 'Topics referred to by the same term' },
      { title: 'Mercury (planet)', pageid: 19008, wikidata: 'Q308', description: 'First planet from the Sun' },
      { title: 'Mercury (element)', pageid: 18617142, wikidata: 'Q925', description: 'Chemical element' },
      { title: 'Freddie Mercury', pageid: 42068, wikidata: 'Q15869', description: 'British singer' },
      { title: 'Intermittent fasting', pageid: 4000, wikidata: 'Q1476397', langlinks: { de: 'Intervallfasten' } },
      {
        title: 'Pilates',
        pageid: 5000,
        wikidata: 'Q192102',
        langlinks: { uk: 'Пілатес', pl: 'Pilates (metoda)', de: 'Pilates (Begriffsklärung)' },
      },
      { title: 'Pluto', pageid: 44469, wikidata: 'Q339', langlinks: { uk: 'Плутон' } },
      { title: 'Talk:Astronomy', pageid: 50651, ns: 1 },
    ],
    redirects: {
      'Star gazing': { to: 'Astronomy' },
      'Stellar observation history': { to: 'History of astronomy', fragment: 'Antiquity' },
    },
    search: {
      Astronomy: ['Astronomy', 'History of astronomy', 'Amateur astronomy'],
      Mercury: ['Mercury', 'Mercury (planet)', 'Mercury (element)', 'Freddie Mercury'],
      'Astronomy club': ['Amateur astronomy', 'Astronomy'],
    },
  },
  uk: {
    pages: [
      { title: 'Астрономія', pageid: 827, wikidata: 'Q333', langlinks: { en: 'Astronomy', pl: 'Astronomia' } },
      { title: 'Пілатес (система вправ)', pageid: 900, wikidata: 'Q192102' },
      { title: 'Плутон', pageid: 901, wikidata: 'Q999999' },
    ],
    redirects: { 'Пілатес': { to: 'Пілатес (система вправ)' } },
    search: { 'астрономія': ['Астрономія'] },
  },
  pl: { pages: [{ title: 'Astronomia', pageid: 2221092, wikidata: 'Q333' }] },
  de: {
    pages: [
      { title: 'Astronomie', pageid: 300, wikidata: 'Q333' },
      { title: 'Intervallfasten', pageid: 301, wikidata: 'Q1476397' },
      { title: 'Pilates (Begriffsklärung)', pageid: 302, wikidata: 'Q7194936', disambiguation: true },
    ],
  },
  als: { pages: [{ title: 'Astronomii', pageid: 400, wikidata: 'Q333' }] },
};

function setup(overrides: Partial<FakeWikimediaOptions> = {}) {
  const fake = createFakeWikimedia({ wikis: WIKIS, ...overrides });
  const api = createJsonClient({ transport: fake.transport, sleep: async () => {} });
  const resolve = async (request: Partial<ResolveRequest> & { topic: string }) => {
    const outcome = await resolveTopic(api, { lang: 'en', languages: null, limit: 5, ...request });
    // Every outcome must satisfy the public contract.
    ResolveResultSchema.parse(outcome.result);
    return outcome;
  };
  return { ...fake, api, resolve };
}

function warningCodes(outcome: { warnings: { code: string }[] }): string[] {
  return outcome.warnings.map((warning) => warning.code);
}

function hostsCalled(calls: HttpRequest[]): string[] {
  return [...new Set(calls.map((call) => new URL(call.url).hostname))];
}

describe('resolveTopic: existing article', () => {
  it('resolves the source article and verifies linked articles in each requested edition', async () => {
    const { resolve } = setup();
    const { result, warnings, limitations } = await resolve({ topic: 'Astronomy', languages: ['en', 'uk', 'pl'] });

    expect(result).toMatchObject({
      topic: 'Astronomy',
      status: 'resolved',
      reason: 'exact_title',
      sourceLanguage: 'en',
      source: { lang: 'en', title: 'Astronomy', pageId: 50650, wikidataId: 'Q333', url: 'https://en.wikipedia.org/wiki/Astronomy' },
      missingLanguages: [],
    });
    expect(result.articles.map((article) => [article.lang, article.status, article.via, article.title])).toEqual([
      ['en', 'verified', 'source', 'Astronomy'],
      ['uk', 'verified', 'language_link', 'Астрономія'],
      ['pl', 'verified', 'language_link', 'Astronomia'],
    ]);
    expect(warnings).toEqual([]);
    expect(limitations.length).toBeGreaterThan(0);
  });

  it('offers other search results as candidates, excluding the resolved article', async () => {
    const { resolve } = setup();
    const { result } = await resolve({ topic: 'Astronomy' });
    expect(result.candidates.map((candidate) => candidate.title)).toEqual(['History of astronomy', 'Amateur astronomy']);
    expect(result.candidates[0]?.description).toBeNull();
    expect(result.articles).toHaveLength(1);
  });

  it('normalizes the title and reports the original spelling', async () => {
    const { resolve } = setup();
    const { result } = await resolve({ topic: 'astronomy' });
    expect(result.source).toMatchObject({ title: 'Astronomy', normalizedFrom: 'astronomy' });
  });

  it('maps site-matrix language codes to the edition subdomain', async () => {
    const { resolve } = setup();
    const outcome = await resolve({ topic: 'Astronomy', languages: ['gsw'] });
    expect(outcome.result.articles[0]).toMatchObject({
      lang: 'als',
      status: 'verified',
      title: 'Astronomii',
      edition: { requestedCode: 'gsw', code: 'als' },
    });
    expect(warningCodes(outcome)).toEqual(['LANGUAGE_CODE_MAPPED']);
  });

  it('follows langlink continuation pages', async () => {
    const { resolve, calls } = setup({ wikis: { ...WIKIS, en: { ...WIKIS.en!, langlinksPageSize: 1 } } });
    const { result } = await resolve({ topic: 'Astronomy', languages: ['als'] });
    expect(result.articles[0]).toMatchObject({ status: 'verified', title: 'Astronomii' });
    expect(calls.filter((call) => call.params.llcontinue !== undefined)).toHaveLength(3);
  });
});

describe('resolveTopic: non-existing article', () => {
  it('returns not_found when neither an exact title nor search results exist', async () => {
    const { resolve } = setup();
    const { result } = await resolve({ topic: 'Qwxzv nonexistent', languages: ['uk'] });
    expect(result).toMatchObject({ status: 'not_found', reason: 'no_results', source: null, articles: [], candidates: [] });
  });

  it('returns candidates without picking one when there is no exact title', async () => {
    const { resolve } = setup();
    const { result } = await resolve({ topic: 'Astronomy club', languages: ['uk'] });
    expect(result).toMatchObject({ status: 'ambiguous', reason: 'no_exact_match', source: null, articles: [] });
    expect(result.candidates.map((candidate) => candidate.title)).toEqual(['Amateur astronomy', 'Astronomy']);
    expect(result.nextStep).toContain('Ask the user');
  });

  it('does not treat pages outside the article namespace as articles', async () => {
    const { api } = setup();
    const en = { code: 'en', languageCode: 'en', name: 'English', autonym: 'English', url: 'https://en.wikipedia.org', closed: false };
    expect(await lookupTitle(api, en, 'Talk:Astronomy')).toEqual({ kind: 'not_article', title: 'Talk:Astronomy', namespace: 1 });
  });

  it('never sends titles containing "|" to the API, which would query several pages', async () => {
    const { resolve, calls } = setup();
    const { result } = await resolve({ topic: 'Astronomy|Mercury' });
    expect(result.status).toBe('not_found');
    expect(calls.some((call) => call.params.titles !== undefined)).toBe(false);
  });
});

describe('resolveTopic: redirects', () => {
  it('resolves a redirect to the canonical article and warns', async () => {
    const { resolve } = setup();
    const outcome = await resolve({ topic: 'Star gazing', languages: ['en', 'pl'] });
    expect(outcome.result.source).toMatchObject({ title: 'Astronomy', redirectedFrom: 'Star gazing', redirectFragment: null });
    expect(outcome.result.articles[0]).toMatchObject({ lang: 'en', title: 'Astronomy', redirectedFrom: 'Star gazing' });
    expect(warningCodes(outcome)).toEqual(['REDIRECT_FOLLOWED']);
  });

  it('warns when a redirect targets a section of a broader article', async () => {
    const { resolve } = setup();
    const outcome = await resolve({ topic: 'Stellar observation history' });
    expect(outcome.result.source).toMatchObject({ title: 'History of astronomy', redirectFragment: 'Antiquity' });
    expect(warningCodes(outcome)).toEqual(['REDIRECT_FOLLOWED', 'REDIRECT_TO_SECTION']);
  });

  it('follows redirects on linked articles in other editions', async () => {
    const { resolve } = setup();
    const outcome = await resolve({ topic: 'Pilates', languages: ['uk'] });
    expect(outcome.result.articles[0]).toMatchObject({
      status: 'verified',
      title: 'Пілатес (система вправ)',
      redirectedFrom: 'Пілатес',
    });
    expect(warningCodes(outcome)).toEqual(['REDIRECT_FOLLOWED']);
  });
});

describe('resolveTopic: disambiguation', () => {
  it('returns candidates instead of the disambiguation page', async () => {
    const { resolve, calls } = setup();
    const { result } = await resolve({ topic: 'Mercury', languages: ['uk', 'pl'], limit: 2 });
    expect(result).toMatchObject({ status: 'ambiguous', reason: 'disambiguation_page', source: null, articles: [] });
    expect(result.candidates.map((candidate) => candidate.title)).toEqual(['Mercury (planet)', 'Mercury (element)']);
    // No language articles are resolved until the ambiguity is settled.
    expect(hostsCalled(calls)).toEqual(['meta.wikimedia.org', 'en.wikipedia.org']);
  });

  it('flags a language link that leads to a disambiguation page as unusable', async () => {
    const { resolve } = setup();
    const outcome = await resolve({ topic: 'Pilates', languages: ['de'] });
    expect(outcome.result.articles[0]).toMatchObject({ status: 'disambiguation', title: 'Pilates (Begriffsklärung)' });
    expect(outcome.result.missingLanguages).toEqual(['de']);
    expect(warningCodes(outcome)).toEqual(['LANGUAGE_LINK_DISAMBIGUATION']);
  });
});

describe('resolveTopic: missing language editions', () => {
  it('reports editions without a linked article and never substitutes search results', async () => {
    const { resolve, calls } = setup();
    const outcome = await resolve({ topic: 'Intermittent fasting', languages: ['en', 'de', 'uk'] });

    expect(outcome.result.articles.map((article) => [article.lang, article.status])).toEqual([
      ['en', 'verified'],
      ['de', 'verified'],
      ['uk', 'missing'],
    ]);
    expect(outcome.result.articles[2]).toMatchObject({ title: null, url: null, pageId: null, via: null });
    expect(outcome.result.missingLanguages).toEqual(['uk']);
    expect(outcome.warnings).toEqual([
      expect.objectContaining({ code: 'LANGUAGE_ARTICLE_MISSING', language: 'uk' }),
    ]);
    expect(outcome.result.nextStep).toContain('do not substitute');
    expect(hostsCalled(calls)).not.toContain('uk.wikipedia.org');
  });

  it('reports interlanguage links to non-existent pages as broken', async () => {
    const { resolve } = setup();
    const outcome = await resolve({ topic: 'Pilates', languages: ['pl'] });
    expect(outcome.result.articles[0]).toMatchObject({ status: 'link_broken', title: 'Pilates (metoda)', url: null });
    expect(outcome.result.missingLanguages).toEqual(['pl']);
    expect(warningCodes(outcome)).toEqual(['LANGUAGE_LINK_BROKEN']);
  });

  it('warns when a linked article belongs to a different Wikidata item', async () => {
    const { resolve } = setup();
    const outcome = await resolve({ topic: 'Pluto', languages: ['uk'] });
    expect(outcome.result.articles[0]?.status).toBe('verified');
    expect(warningCodes(outcome)).toEqual(['WIKIDATA_MISMATCH']);
  });

  it('warns about closed editions', async () => {
    const { resolve } = setup();
    const outcome = await resolve({ topic: 'Astronomy', languages: ['aa'] });
    expect(outcome.result.articles[0]?.status).toBe('missing');
    expect(warningCodes(outcome)).toEqual(['EDITION_CLOSED', 'LANGUAGE_ARTICLE_MISSING']);
  });
});

describe('resolveTopic: invalid language codes', () => {
  it('rejects unknown editions before querying any article', async () => {
    const { resolve, calls } = setup();
    const error = await resolve({ topic: 'Astronomy', languages: ['uk', 'xx', 'zz'] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidLanguageError);
    expect((error as InvalidLanguageError).codes).toEqual(['xx', 'zz']);
    expect(hostsCalled(calls)).toEqual(['meta.wikimedia.org']);
  });

  it('rejects an unknown source edition', async () => {
    const { resolve } = setup();
    await expect(resolve({ topic: 'Astronomy', lang: 'xx' })).rejects.toThrow(InvalidLanguageError);
  });
});

describe('resolveTopic: API failures', () => {
  it('propagates HTTP errors after retries', async () => {
    const { resolve, calls } = setup({
      override: (request) => (request.params.titles !== undefined ? { status: 503, data: 'Service Unavailable' } : undefined),
    });
    const error = await resolve({ topic: 'Astronomy' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WikimediaApiError);
    expect(error).toMatchObject({ kind: 'http', status: 503 });
    expect(calls.filter((call) => call.params.titles !== undefined)).toHaveLength(3);
  });

  it('propagates MediaWiki error bodies', async () => {
    const { resolve } = setup({
      override: (request) =>
        request.params.generator === 'search' ? { status: 200, data: { error: { code: 'internal_api_error', info: 'boom' } } } : undefined,
    });
    await expect(resolve({ topic: 'Astronomy' })).rejects.toMatchObject({ kind: 'api_error' });
  });
});

describe('resolveTopic: unexpected API responses', () => {
  it.each([
    ['pages with the wrong type', { query: { pages: 'Astronomy' } }],
    ['no pages for a title query', { batchcomplete: true, query: {} }],
    ['two pages for one title', { query: { pages: [{ ns: 0, title: 'A', missing: true }, { ns: 0, title: 'B', missing: true }] } }],
    ['a found page without an ID or URL', { query: { pages: [{ ns: 0, title: 'Astronomy' }] } }],
  ])('rejects %s', async (_label, data) => {
    const { resolve } = setup({ override: (request) => (request.params.titles !== undefined ? { status: 200, data } : undefined) });
    await expect(resolve({ topic: 'Astronomy' })).rejects.toMatchObject({ kind: 'unexpected_response' });
  });

  it('rejects an HTML error page', async () => {
    const { resolve } = setup({ override: () => ({ status: 200, data: '<html>maintenance</html>' }) });
    await expect(resolve({ topic: 'Astronomy' })).rejects.toMatchObject({ kind: 'unexpected_response' });
  });
});

describe('resolveTopic: Unicode titles', () => {
  it('resolves a Cyrillic topic in the Ukrainian edition and links to Polish and English', async () => {
    const { resolve, calls } = setup();
    const outcome = await resolve({ topic: 'астрономія', lang: 'uk', languages: ['uk', 'pl', 'en'] });

    expect(outcome.result.source).toMatchObject({ lang: 'uk', title: 'Астрономія', normalizedFrom: 'астрономія' });
    expect(outcome.result.source?.url).toBe('https://uk.wikipedia.org/wiki/%D0%90%D1%81%D1%82%D1%80%D0%BE%D0%BD%D0%BE%D0%BC%D1%96%D1%8F');
    expect(outcome.result.articles.map((article) => article.title)).toEqual(['Астрономія', 'Astronomia', 'Astronomy']);
    // Titles are passed to the transport unencoded; encoding is the HTTP layer's job.
    expect(calls.some((call) => call.params.titles === 'астрономія')).toBe(true);
  });
});
