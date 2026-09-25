import type { Warning } from '../schemas/envelope.ts';
import type { ResolveRequest } from '../schemas/inputs.ts';
import type { LanguageArticle, ResolveResult } from '../schemas/resolve.ts';
import { fetchWikipediaEditions, type EditionIndex, type WikipediaEdition } from './editions.ts';
import type { JsonClient } from './http.ts';
import { lookupTitle, searchArticles, type ArticlePage, type TitleLookup } from './mediawiki.ts';

export const RESOLVE_LIMITATIONS: readonly string[] = [
  'Articles in other language editions come from Wikipedia interlanguage links; their scope may be broader or narrower than the source article.',
  'Search candidates are ranked by Wikipedia search relevance, not by relevance to the research question.',
  'Exactly one article per language edition is used; related articles and redirects are not aggregated.',
];

const SEARCH_HEADROOM = 3;

export class InvalidLanguageError extends Error {
  readonly codes: string[];

  constructor(codes: string[]) {
    super(`Unknown Wikipedia language edition${codes.length > 1 ? 's' : ''}: ${codes.join(', ')}.`);
    this.name = 'InvalidLanguageError';
    this.codes = codes;
  }
}

export interface ResolveOutcome {
  result: ResolveResult;
  warnings: Warning[];
  limitations: string[];
}

type FoundLookup = Extract<TitleLookup, { kind: 'found' }>;

function toCandidate(page: ArticlePage) {
  return { lang: page.lang, title: page.title, pageId: page.pageId, url: page.url, description: page.description };
}

function editionInfo(requestedCode: string, edition: WikipediaEdition) {
  return {
    requestedCode,
    code: edition.code,
    name: edition.name,
    autonym: edition.autonym,
    url: edition.url,
    closed: edition.closed,
  };
}

/** Validates every requested code against the site matrix; unknown codes are an input error, never skipped. */
function resolveEditions(index: EditionIndex, codes: readonly string[]): Map<string, WikipediaEdition> {
  const editions = new Map<string, WikipediaEdition>();
  const invalid: string[] = [];
  for (const code of codes) {
    const edition = index.lookup(code);
    if (edition) editions.set(code, edition);
    else invalid.push(code);
  }
  if (invalid.length > 0) throw new InvalidLanguageError(invalid);
  return editions;
}

function editionWarnings(requestedCode: string, edition: WikipediaEdition): Warning[] {
  const warnings: Warning[] = [];
  if (edition.code !== requestedCode) {
    warnings.push({
      code: 'LANGUAGE_CODE_MAPPED',
      message: `Language code "${requestedCode}" refers to ${edition.code}.wikipedia.org; "${edition.code}" is used from here on.`,
      language: edition.code,
    });
  }
  if (edition.closed) {
    warnings.push({
      code: 'EDITION_CLOSED',
      message: `${edition.code}.wikipedia.org is closed (read-only); its content and traffic may be minimal.`,
      language: edition.code,
    });
  }
  return warnings;
}

function redirectWarnings(lookup: FoundLookup): Warning[] {
  const { article, redirectedFrom, redirectFragment } = lookup;
  if (redirectedFrom === null) return [];
  const warnings: Warning[] = [
    {
      code: 'REDIRECT_FOLLOWED',
      message: `"${redirectedFrom}" redirects to "${article.title}" (${article.lang}). The canonical title is used; views of the redirect title are counted separately by Wikipedia.`,
      language: article.lang,
    },
  ];
  if (redirectFragment !== null) {
    warnings.push({
      code: 'REDIRECT_TO_SECTION',
      message: `"${redirectedFrom}" redirects to the section "${redirectFragment}" of "${article.title}" (${article.lang}). The whole article is broader than the requested topic.`,
      language: article.lang,
    });
  }
  return warnings;
}

async function resolveLanguageArticle(
  api: JsonClient,
  source: FoundLookup,
  requestedCode: string,
  edition: WikipediaEdition,
  warnings: Warning[],
): Promise<LanguageArticle> {
  const empty = { title: null, pageId: null, url: null, wikidataId: null, redirectedFrom: null };
  const base = { lang: edition.code, edition: editionInfo(requestedCode, edition) };

  if (edition.code === source.article.lang) {
    const { title, pageId, url, wikidataId } = source.article;
    return { ...base, status: 'verified', via: 'source', title, pageId, url, wikidataId, redirectedFrom: source.redirectedFrom };
  }

  const link = source.languageLinks.find((candidate) => candidate.lang === edition.code || candidate.lang === edition.languageCode);
  if (!link) {
    warnings.push({
      code: 'LANGUAGE_ARTICLE_MISSING',
      message: `"${source.article.title}" (${source.article.lang}) has no linked article in ${edition.code}.wikipedia.org. No substitute was chosen.`,
      language: edition.code,
    });
    return { ...base, status: 'missing', via: null, ...empty };
  }

  const target = await lookupTitle(api, edition, link.title);
  if (target.kind !== 'found') {
    warnings.push({
      code: 'LANGUAGE_LINK_BROKEN',
      message: `The interlanguage link to "${link.title}" (${edition.code}) does not lead to an existing article (${target.kind}).`,
      language: edition.code,
    });
    return { ...base, status: 'link_broken', via: 'language_link', ...empty, title: link.title };
  }

  const { article } = target;
  const found = { title: article.title, pageId: article.pageId, url: article.url, wikidataId: article.wikidataId, redirectedFrom: target.redirectedFrom };
  if (article.isDisambiguation) {
    warnings.push({
      code: 'LANGUAGE_LINK_DISAMBIGUATION',
      message: `The interlanguage link leads to the disambiguation page "${article.title}" (${edition.code}), which is not a topic article.`,
      language: edition.code,
    });
    return { ...base, status: 'disambiguation', via: 'language_link', ...found };
  }

  warnings.push(...redirectWarnings(target));
  const sourceItem = source.article.wikidataId;
  if (sourceItem !== null && article.wikidataId !== null && sourceItem !== article.wikidataId) {
    warnings.push({
      code: 'WIKIDATA_MISMATCH',
      message: `"${article.title}" (${edition.code}) is ${article.wikidataId} in Wikidata, while the source article is ${sourceItem}. The articles may cover different topics.`,
      language: edition.code,
    });
  }
  return { ...base, status: 'verified', via: 'language_link', ...found };
}

function nextStepFor(result: Omit<ResolveResult, 'nextStep'>): string {
  switch (result.status) {
    case 'resolved': {
      const confirm =
        'Confirm the source article matches the topic the user means. If a candidate fits better, run resolve again with --topic set to that exact title.';
      return result.missingLanguages.length === 0
        ? `Use the verified articles. ${confirm}`
        : `Use the verified articles. No verified article exists for: ${result.missingLanguages.join(', ')}. Report these languages as unavailable; do not substitute translated or searched titles. ${confirm}`;
    }
    case 'ambiguous':
      return 'Ask the user which candidate they mean (choose yourself only if the conversation makes it unambiguous), then run resolve again with --topic set to that candidate\'s exact title.';
    case 'not_found':
      return 'No article or search result matches this topic. Ask the user to rephrase the topic or to name another source language.';
  }
}

/**
 * Resolves a topic to one verified article per requested language edition.
 *
 * 1. Validate every language code against the Wikimedia site matrix.
 * 2. Look up the topic as an exact title in the source edition (following one redirect).
 * 3. Search the source edition for alternative candidates.
 * 4. An existing non-disambiguation page → `resolved`; a disambiguation page or no exact title
 *    with search results → `ambiguous`; nothing at all → `not_found`.
 * 5. When resolved, follow the source article's interlanguage links to each requested edition and
 *    verify each target page. Editions without a link are reported missing, never filled by search.
 */
export async function resolveTopic(api: JsonClient, request: ResolveRequest): Promise<ResolveOutcome> {
  const index = await fetchWikipediaEditions(api);
  const targetCodes = [...new Set(request.languages ?? [request.lang])];
  const editions = resolveEditions(index, [...new Set([request.lang, ...targetCodes])]);
  const sourceEdition = editions.get(request.lang) as WikipediaEdition;

  const warnings: Warning[] = [];
  const seenEditions = new Set<string>();
  for (const [code, edition] of editions) {
    if (seenEditions.has(edition.code)) continue;
    seenEditions.add(edition.code);
    warnings.push(...editionWarnings(code, edition));
  }

  const exact = await lookupTitle(api, sourceEdition, request.topic, { languageLinks: true });
  const found = exact.kind === 'found' ? exact : null;
  // Extra results leave room for dropping the exact match and disambiguation pages.
  const searchResults = await searchArticles(api, sourceEdition, request.topic, request.limit + SEARCH_HEADROOM);
  const candidates = searchResults
    .filter((page) => !page.isDisambiguation && page.pageId !== found?.article.pageId)
    .slice(0, request.limit)
    .map(toCandidate);

  const common = { topic: request.topic, sourceLanguage: sourceEdition.code, candidates };
  let partial: Omit<ResolveResult, 'nextStep'>;

  if (found && !found.article.isDisambiguation) {
    warnings.unshift(...redirectWarnings(found));
    const articles: LanguageArticle[] = [];
    const resolvedCodes = new Set<string>();
    for (const code of targetCodes) {
      const edition = editions.get(code) as WikipediaEdition;
      if (resolvedCodes.has(edition.code)) continue;
      resolvedCodes.add(edition.code);
      articles.push(await resolveLanguageArticle(api, found, code, edition, warnings));
    }
    const { lang, title, pageId, url, description, wikidataId } = found.article;
    partial = {
      ...common,
      status: 'resolved',
      reason: 'exact_title',
      source: {
        lang,
        title,
        pageId,
        url,
        description,
        wikidataId,
        normalizedFrom: found.normalizedFrom,
        redirectedFrom: found.redirectedFrom,
        redirectFragment: found.redirectFragment,
      },
      articles,
      missingLanguages: articles.filter((article) => article.status !== 'verified').map((article) => article.lang),
    };
  } else {
    const status = found !== null || candidates.length > 0 ? 'ambiguous' : 'not_found';
    const reason = found !== null ? 'disambiguation_page' : candidates.length > 0 ? 'no_exact_match' : 'no_results';
    partial = { ...common, status, reason, source: null, articles: [], missingLanguages: [] };
  }

  return {
    result: { ...partial, nextStep: nextStepFor(partial) },
    warnings,
    limitations: [...RESOLVE_LIMITATIONS],
  };
}
