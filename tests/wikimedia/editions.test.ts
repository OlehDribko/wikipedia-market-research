import { describe, expect, it } from 'vitest';
import { fetchWikipediaEditions, parseSiteMatrix } from '../../src/wikimedia/editions.ts';
import { createJsonClient, WikimediaApiError } from '../../src/wikimedia/http.ts';
import { createFakeWikimedia } from '../helpers/fakeWikimedia.ts';

describe('fetchWikipediaEditions', () => {
  it('indexes Wikipedia editions only, by subdomain and by site-matrix code', async () => {
    const { transport, calls } = createFakeWikimedia({ wikis: {} });
    const index = await fetchWikipediaEditions(createJsonClient({ transport }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toMatchObject({ action: 'sitematrix', formatversion: '2' });
    expect(index.size).toBe(6);
    expect(index.lookup('uk')).toEqual({
      code: 'uk',
      languageCode: 'uk',
      name: 'Ukrainian',
      autonym: 'українська',
      url: 'https://uk.wikipedia.org',
      closed: false,
    });
    expect(index.lookup('gsw')?.code).toBe('als');
    expect(index.lookup('als')?.languageCode).toBe('gsw');
    expect(index.lookup('aa')?.closed).toBe(true);
    expect(index.lookup('EN')?.code).toBe('en');
  });

  it('does not recognise unknown codes or non-Wikipedia projects', async () => {
    const { transport } = createFakeWikimedia({ wikis: {} });
    const index = await fetchWikipediaEditions(createJsonClient({ transport }));
    for (const code of ['xx', 'english', 'commons', 'wiktionary']) expect(index.lookup(code)).toBeUndefined();
  });
});

describe('parseSiteMatrix', () => {
  it.each([
    ['missing sitematrix', { batchcomplete: true }],
    ['malformed entry', { sitematrix: { count: 1, 0: { code: 5 } } }],
    ['no Wikipedia editions', { sitematrix: { count: 0 } }],
  ])('rejects %s as an unexpected response', (_label, data) => {
    expect(() => parseSiteMatrix(data)).toThrow(WikimediaApiError);
  });
});
