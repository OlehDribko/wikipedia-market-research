import { z } from 'zod';
import type { WikipediaEdition } from './editions.ts';
import { parseResponse, WikimediaApiError, type JsonClient } from './http.ts';

/** A verified main-namespace page. */
export interface ArticlePage {
  lang: string;
  title: string;
  pageId: number;
  url: string;
  description: string | null;
  wikidataId: string | null;
  isDisambiguation: boolean;
}

export interface LanguageLink {
  lang: string;
  title: string;
}

export type TitleLookup =
  | {
      kind: 'found';
      article: ArticlePage;
      /** Title as submitted when MediaWiki normalized it (case, underscores). */
      normalizedFrom: string | null;
      /** Redirect title that led to the article, if any. */
      redirectedFrom: string | null;
      /** Section the redirect points to; the article may be broader than the requested title. */
      redirectFragment: string | null;
      languageLinks: LanguageLink[];
    }
  | { kind: 'missing'; title: string }
  | { kind: 'invalid'; title: string; reason: string }
  | { kind: 'not_article'; title: string; namespace: number };

const PageSchema = z.object({
  pageid: z.number().int().optional(),
  ns: z.number().int(),
  title: z.string(),
  missing: z.boolean().optional(),
  invalid: z.boolean().optional(),
  invalidreason: z.string().optional(),
  redirect: z.boolean().optional(),
  canonicalurl: z.string().optional(),
  description: z.string().optional(),
  pageprops: z
    .object({
      disambiguation: z.string().optional(),
      wikibase_item: z.string().optional(),
    })
    .optional(),
  langlinks: z.array(z.object({ lang: z.string(), title: z.string() })).optional(),
  index: z.number().int().optional(),
});
type Page = z.infer<typeof PageSchema>;

const TitleMappingSchema = z.object({ from: z.string(), to: z.string(), tofragment: z.string().optional() });

const QueryResponseSchema = z.object({
  continue: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  query: z
    .object({
      normalized: z.array(TitleMappingSchema).optional(),
      redirects: z.array(TitleMappingSchema).optional(),
      pages: z.array(PageSchema).optional(),
    })
    .optional(),
});

/** Characters MediaWiki forbids in titles. `|` would also split one lookup into several titles. */
const ILLEGAL_TITLE_CHARS = /[#<>[\]|{}\u0000-\u001f\u007f]/;
const MAX_CONTINUATIONS = 10;
const PAGE_PROPS = { prop: 'info|pageprops|description', inprop: 'url', ppprop: 'disambiguation|wikibase_item' };

/** The parts of an edition needed to call its API. */
export type EditionRef = Pick<WikipediaEdition, 'code' | 'url'>;

function apiUrl(edition: EditionRef): string {
  return `${edition.url}/w/api.php`;
}

function toArticle(page: Page, edition: EditionRef, url: string): ArticlePage {
  if (page.pageid === undefined || page.canonicalurl === undefined) {
    throw new WikimediaApiError('unexpected_response', `Page "${page.title}" is missing its ID or URL in the response from ${url}.`, url, 200);
  }
  return {
    lang: edition.code,
    title: page.title,
    pageId: page.pageid,
    url: page.canonicalurl,
    description: page.description?.trim() || null,
    wikidataId: page.pageprops?.wikibase_item ?? null,
    isDisambiguation: page.pageprops?.disambiguation !== undefined,
  };
}

/**
 * Looks up one exact title in an edition, following a single redirect.
 * Never falls back to search: a missing title is reported as missing.
 */
export async function lookupTitle(
  api: JsonClient,
  edition: EditionRef,
  title: string,
  options: { languageLinks?: boolean } = {},
): Promise<TitleLookup> {
  const requested = title.trim();
  if (requested.length === 0 || requested.length > 255 || ILLEGAL_TITLE_CHARS.test(requested)) {
    return { kind: 'invalid', title: requested, reason: 'Contains characters that are not allowed in Wikipedia titles.' };
  }

  const url = apiUrl(edition);
  const baseParams: Record<string, string> = {
    action: 'query',
    format: 'json',
    formatversion: '2',
    redirects: '1',
    titles: requested,
    ...PAGE_PROPS,
    prop: options.languageLinks ? `${PAGE_PROPS.prop}|langlinks` : PAGE_PROPS.prop,
    ...(options.languageLinks && { lllimit: 'max' }),
  };

  const first = parseResponse(QueryResponseSchema, await api.getJson(url, baseParams), url);
  const pages = first.query?.pages ?? [];
  const page = pages[0];
  if (pages.length !== 1 || page === undefined) {
    throw new WikimediaApiError('unexpected_response', `Expected exactly one page for "${requested}" from ${url}, got ${pages.length}.`, url, 200);
  }

  const languageLinks = [...(page.langlinks ?? [])];
  let response = first;
  for (let round = 0; response.continue !== undefined && round < MAX_CONTINUATIONS; round++) {
    const continuation = Object.fromEntries(Object.entries(response.continue).map(([key, value]) => [key, String(value)]));
    response = parseResponse(QueryResponseSchema, await api.getJson(url, { ...baseParams, ...continuation }), url);
    languageLinks.push(...(response.query?.pages?.[0]?.langlinks ?? []));
  }

  if (page.invalid) return { kind: 'invalid', title: requested, reason: page.invalidreason ?? 'Invalid title.' };
  if (page.missing) return { kind: 'missing', title: page.title };
  if (page.ns !== 0) return { kind: 'not_article', title: page.title, namespace: page.ns };
  if (page.redirect) {
    // A redirect that still resolves to a redirect (double redirect) is not a verified article.
    return { kind: 'invalid', title: page.title, reason: 'Unresolved double redirect.' };
  }

  const normalized = first.query?.normalized?.[0] ?? null;
  const redirect = first.query?.redirects?.[0] ?? null;
  return {
    kind: 'found',
    article: toArticle(page, edition, url),
    normalizedFrom: normalized?.from ?? null,
    redirectedFrom: redirect?.from ?? null,
    redirectFragment: redirect?.tofragment ?? null,
    languageLinks,
  };
}

/** Full-text search in the main namespace, in Wikipedia's relevance order. */
export async function searchArticles(
  api: JsonClient,
  edition: EditionRef,
  query: string,
  limit: number,
): Promise<ArticlePage[]> {
  const url = apiUrl(edition);
  const data = await api.getJson(url, {
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrsearch: query,
    gsrlimit: String(limit),
    gsrnamespace: '0',
    ...PAGE_PROPS,
  });
  const response = parseResponse(QueryResponseSchema, data, url);
  return (response.query?.pages ?? [])
    .filter((page) => !page.missing && page.ns === 0)
    .sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER))
    .map((page) => toArticle(page, edition, url));
}

const RevisionResponseSchema = z.object({
  query: z.object({
    pages: z.array(
      z.object({
        pageid: z.number().int().optional(),
        missing: z.boolean().optional(),
        revisions: z.array(z.object({ timestamp: z.iso.datetime() })).optional(),
      }),
    ),
  }),
});

/**
 * Timestamp of the page's first revision (its creation), or null when the page or its history is unavailable.
 * Page moves keep their history, so a renamed article reports its original creation time.
 */
export async function fetchFirstRevisionTimestamp(api: JsonClient, edition: EditionRef, pageId: number): Promise<string | null> {
  const url = apiUrl(edition);
  const data = await api.getJson(url, {
    action: 'query',
    format: 'json',
    formatversion: '2',
    pageids: String(pageId),
    prop: 'revisions',
    rvprop: 'timestamp',
    rvlimit: '1',
    rvdir: 'newer',
  });
  const page = parseResponse(RevisionResponseSchema, data, url).query.pages[0];
  if (!page || page.missing || page.pageid !== pageId) return null;
  return page.revisions?.[0]?.timestamp ?? null;
}
