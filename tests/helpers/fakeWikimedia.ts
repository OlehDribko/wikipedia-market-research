import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/wikimedia/http.ts';

/** Minimal in-memory imitation of the MediaWiki Action API (formatversion=2) for deterministic tests. */

export interface FakePage {
  title: string;
  pageid: number;
  ns?: number;
  description?: string;
  wikidata?: string;
  disambiguation?: boolean;
  langlinks?: Record<string, string>;
}

export interface FakeWiki {
  pages: FakePage[];
  /** Redirect title → target title, optionally with a section fragment. */
  redirects?: Record<string, { to: string; fragment?: string }>;
  /** Search query → result titles in relevance order. */
  search?: Record<string, string[]>;
  /** Paginate langlinks to exercise `continue` handling. */
  langlinksPageSize?: number;
}

export interface FakeEdition {
  languageCode: string;
  subdomain?: string;
  name: string;
  autonym: string;
  closed?: boolean;
}

export const FAKE_EDITIONS: FakeEdition[] = [
  { languageCode: 'en', name: 'English', autonym: 'English' },
  { languageCode: 'uk', name: 'Ukrainian', autonym: 'українська' },
  { languageCode: 'pl', name: 'Polish', autonym: 'polski' },
  { languageCode: 'de', name: 'German', autonym: 'Deutsch' },
  { languageCode: 'gsw', subdomain: 'als', name: 'Alemannic', autonym: 'Alemannisch' },
  { languageCode: 'aa', name: 'Afar', autonym: 'Qafár af', closed: true },
];

export interface FakeWikimediaOptions {
  wikis: Record<string, FakeWiki>;
  editions?: FakeEdition[];
  /** Return a response to short-circuit the simulator (e.g. to inject errors). */
  override?: (request: HttpRequest) => HttpResponse | undefined;
}

function ok(data: unknown): HttpResponse {
  return { status: 200, data };
}

function normalizeTitle(title: string): string {
  const spaced = title.replaceAll('_', ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function pageUrl(subdomain: string, title: string): string {
  return `https://${subdomain}.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`;
}

function renderPage(subdomain: string, page: FakePage, extra: Record<string, unknown> = {}) {
  const pageprops: Record<string, string> = {};
  if (page.disambiguation) pageprops.disambiguation = '';
  if (page.wikidata) pageprops.wikibase_item = page.wikidata;
  return {
    pageid: page.pageid,
    ns: page.ns ?? 0,
    title: page.title,
    canonicalurl: pageUrl(subdomain, page.title),
    ...(page.description !== undefined && { description: page.description }),
    ...(Object.keys(pageprops).length > 0 && { pageprops }),
    ...extra,
  };
}

function siteMatrix(editions: FakeEdition[]) {
  const matrix: Record<string, unknown> = { count: editions.length };
  editions.forEach((edition, index) => {
    const subdomain = edition.subdomain ?? edition.languageCode;
    matrix[String(index)] = {
      code: edition.languageCode,
      name: edition.autonym,
      localname: edition.name,
      site: [
        { url: `https://${subdomain}.wikipedia.org`, code: 'wiki', ...(edition.closed && { closed: true }) },
        { url: `https://${subdomain}.wiktionary.org`, code: 'wiktionary' },
      ],
    };
  });
  matrix.specials = [{ url: 'https://commons.wikimedia.org', code: 'commons' }];
  return { sitematrix: matrix };
}

function titleQuery(subdomain: string, wiki: FakeWiki, params: Record<string, string>) {
  const requested = params.titles ?? '';
  const normalizedTitle = normalizeTitle(requested);
  const query: Record<string, unknown> = {};
  if (normalizedTitle !== requested) query.normalized = [{ fromencoded: false, from: requested, to: normalizedTitle }];

  const redirect = wiki.redirects?.[normalizedTitle];
  const finalTitle = redirect?.to ?? normalizedTitle;
  if (redirect) {
    query.redirects = [{ from: normalizedTitle, to: redirect.to, ...(redirect.fragment && { tofragment: redirect.fragment }) }];
  }

  const page = wiki.pages.find((candidate) => candidate.title === finalTitle);
  if (!page) {
    query.pages = [{ ns: 0, title: finalTitle, missing: true }];
    return ok({ batchcomplete: true, query });
  }

  const wantsLanglinks = (params.prop ?? '').split('|').includes('langlinks');
  const allLinks = Object.entries(page.langlinks ?? {}).map(([lang, title]) => ({ lang, title }));
  const offset = Number(params.llcontinue ?? 0);
  const size = wiki.langlinksPageSize ?? allLinks.length;
  const links = allLinks.slice(offset, offset + size);
  const hasMore = wantsLanglinks && offset + size < allLinks.length;

  query.pages = [renderPage(subdomain, page, wantsLanglinks && links.length > 0 ? { langlinks: links } : {})];
  return ok({
    ...(hasMore ? { continue: { llcontinue: String(offset + size), continue: '||' } } : { batchcomplete: true }),
    query,
  });
}

function searchQuery(subdomain: string, wiki: FakeWiki, params: Record<string, string>) {
  const titles = (wiki.search?.[params.gsrsearch ?? ''] ?? []).slice(0, Number(params.gsrlimit ?? 10));
  if (titles.length === 0) return ok({ batchcomplete: true });
  // Generator results arrive unordered; `index` carries the relevance rank.
  const pages = titles
    .map((title, index) => {
      const page = wiki.pages.find((candidate) => candidate.title === title);
      if (!page) throw new Error(`Fake search result "${title}" has no page in ${subdomain}.`);
      return renderPage(subdomain, page, { index: index + 1 });
    })
    .reverse();
  return ok({ batchcomplete: true, continue: { gsroffset: titles.length, continue: 'gsroffset||' }, query: { pages } });
}

export function createFakeWikimedia(options: FakeWikimediaOptions): { transport: HttpTransport; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const editions = options.editions ?? FAKE_EDITIONS;

  const transport: HttpTransport = async (request) => {
    calls.push(request);
    const overridden = options.override?.(request);
    if (overridden) return overridden;

    const { hostname } = new URL(request.url);
    if (hostname === 'meta.wikimedia.org' && request.params.action === 'sitematrix') return ok(siteMatrix(editions));

    const subdomain = /^([a-z0-9-]+)\.wikipedia\.org$/.exec(hostname)?.[1];
    const wiki = subdomain ? options.wikis[subdomain] : undefined;
    if (!subdomain || !wiki) throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);

    if (request.params.generator === 'search') return searchQuery(subdomain, wiki, request.params);
    if (request.params.titles !== undefined) return titleQuery(subdomain, wiki, request.params);
    return { status: 400, data: { error: { code: 'badvalue', info: 'Unsupported fake request.' } } };
  };

  return { transport, calls };
}
