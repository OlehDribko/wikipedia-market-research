/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { ResolveResultSchema } from '../../src/schemas/resolve.ts';
import { buildUserAgent, createAxiosTransport, createJsonClient } from '../../src/wikimedia/http.ts';
import { resolveTopic } from '../../src/wikimedia/resolve.ts';

// Real Wikimedia requests. Skipped by `npm test`; run with `npm run test:live`.
describe.skipIf(import.meta.env.MODE !== 'live')('live Wikimedia API', () => {
  const api = createJsonClient({ transport: createAxiosTransport(buildUserAgent()) });

  it('resolves Astronomy to verified Ukrainian and Polish articles', { timeout: 30_000 }, async () => {
    const { result, warnings } = await resolveTopic(api, { topic: 'Astronomy', lang: 'en', languages: ['en', 'uk', 'pl'], limit: 3 });

    ResolveResultSchema.parse(result);
    expect(result.status).toBe('resolved');
    expect(result.source).toMatchObject({ title: 'Astronomy', wikidataId: 'Q333' });
    expect(result.articles.map((article) => [article.lang, article.status, article.title, article.wikidataId])).toEqual([
      ['en', 'verified', 'Astronomy', 'Q333'],
      ['uk', 'verified', 'Астрономія', 'Q333'],
      ['pl', 'verified', 'Astronomia', 'Q333'],
    ]);
    expect(result.missingLanguages).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('reports the English disambiguation page for Mercury as ambiguous', { timeout: 30_000 }, async () => {
    const { result } = await resolveTopic(api, { topic: 'Mercury', lang: 'en', languages: ['uk'], limit: 5 });
    expect(result).toMatchObject({ status: 'ambiguous', reason: 'disambiguation_page' });
    expect(result.candidates.length).toBeGreaterThan(0);
  });
});
