import { z } from 'zod';
import { parseResponse, WikimediaApiError, type JsonClient } from './http.ts';

export const SITEMATRIX_URL = 'https://meta.wikimedia.org/w/api.php';

export interface WikipediaEdition {
  /** Subdomain used by Wikipedia URLs and the pageviews API, e.g. "als" for als.wikipedia.org. */
  code: string;
  /** Language code in the Wikimedia site matrix; differs from `code` for a few editions (e.g. "gsw"). */
  languageCode: string;
  /** English language name, e.g. "Ukrainian". */
  name: string;
  /** Language name in the language itself, e.g. "українська". */
  autonym: string;
  /** Origin, e.g. "https://uk.wikipedia.org". */
  url: string;
  /** Closed (read-only) editions exist but receive no new content. */
  closed: boolean;
}

const SiteSchema = z.object({
  url: z.string(),
  code: z.string(),
  closed: z.boolean().optional(),
});

const LanguageEntrySchema = z.object({
  code: z.string().min(1),
  name: z.string().optional(),
  localname: z.string().optional(),
  site: z.array(SiteSchema).optional(),
});

const SiteMatrixResponseSchema = z.object({
  sitematrix: z.record(z.string(), z.unknown()),
});

export class EditionIndex {
  readonly #byCode = new Map<string, WikipediaEdition>();

  constructor(editions: readonly WikipediaEdition[]) {
    // Subdomains take precedence over site-matrix language codes when both could match.
    for (const edition of editions) this.#byCode.set(edition.languageCode, edition);
    for (const edition of editions) this.#byCode.set(edition.code, edition);
  }

  get size(): number {
    return new Set(this.#byCode.values()).size;
  }

  /** Accepts either the subdomain ("als") or the site-matrix language code ("gsw"). */
  lookup(code: string): WikipediaEdition | undefined {
    return this.#byCode.get(code.toLowerCase());
  }
}

function subdomainOf(siteUrl: string): string | null {
  try {
    const { protocol, hostname } = new URL(siteUrl);
    const match = /^([a-z0-9-]+)\.wikipedia\.org$/.exec(hostname);
    return protocol === 'https:' && match?.[1] ? match[1] : null;
  } catch {
    return null;
  }
}

/** Parses the site matrix into the list of Wikipedia language editions. */
export function parseSiteMatrix(data: unknown): EditionIndex {
  const { sitematrix } = parseResponse(SiteMatrixResponseSchema, data, SITEMATRIX_URL);
  const editions: WikipediaEdition[] = [];

  for (const [key, value] of Object.entries(sitematrix)) {
    if (key === 'count' || key === 'specials') continue;
    const entry = parseResponse(LanguageEntrySchema, value, SITEMATRIX_URL);
    for (const site of entry.site ?? []) {
      if (site.code !== 'wiki') continue;
      const code = subdomainOf(site.url);
      if (code === null) continue;
      editions.push({
        code,
        languageCode: entry.code,
        name: entry.localname ?? entry.name ?? entry.code,
        autonym: entry.name ?? entry.localname ?? entry.code,
        url: `https://${code}.wikipedia.org`,
        closed: site.closed === true,
      });
    }
  }

  if (editions.length === 0) {
    throw new WikimediaApiError('unexpected_response', 'The Wikimedia site matrix contained no Wikipedia editions.', SITEMATRIX_URL, 200);
  }
  return new EditionIndex(editions);
}

export async function fetchWikipediaEditions(api: JsonClient): Promise<EditionIndex> {
  const data = await api.getJson(SITEMATRIX_URL, {
    action: 'sitematrix',
    smtype: 'language',
    smsiteprop: 'url|code',
    smlangprop: 'code|name|localname|site',
    format: 'json',
    formatversion: '2',
  });
  return parseSiteMatrix(data);
}
