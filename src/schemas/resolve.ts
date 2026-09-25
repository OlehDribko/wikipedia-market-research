import { z } from 'zod';

export const EditionSchema = z
  .object({
    /** Edition code as the user requested it. */
    requestedCode: z.string(),
    /** Canonical edition code (Wikipedia subdomain), used everywhere downstream. */
    code: z.string(),
    name: z.string(),
    autonym: z.string(),
    url: z.string(),
    closed: z.boolean(),
  })
  .strict();

export const CandidateSchema = z
  .object({
    lang: z.string(),
    title: z.string(),
    pageId: z.number().int(),
    url: z.string(),
    description: z.string().nullable(),
  })
  .strict();

export const SourceArticleSchema = CandidateSchema.extend({
  wikidataId: z.string().nullable(),
  /** Title as submitted before MediaWiki normalization, if it changed. */
  normalizedFrom: z.string().nullable(),
  redirectedFrom: z.string().nullable(),
  redirectFragment: z.string().nullable(),
}).strict();

/**
 * - `verified`: an existing, non-disambiguation article reached from the source article.
 * - `missing`: the source article has no interlanguage link to this edition.
 * - `link_broken`: the interlanguage link points to a page that does not exist or is not an article.
 * - `disambiguation`: the interlanguage link points to a disambiguation page.
 */
export const LanguageArticleStatusSchema = z.enum(['verified', 'missing', 'link_broken', 'disambiguation']);
export type LanguageArticleStatus = z.infer<typeof LanguageArticleStatusSchema>;

export const LanguageArticleSchema = z
  .object({
    lang: z.string(),
    edition: EditionSchema,
    status: LanguageArticleStatusSchema,
    via: z.enum(['source', 'language_link']).nullable(),
    title: z.string().nullable(),
    pageId: z.number().int().nullable(),
    url: z.string().nullable(),
    wikidataId: z.string().nullable(),
    redirectedFrom: z.string().nullable(),
  })
  .strict()
  .superRefine((article, ctx) => {
    const hasPage = article.pageId !== null && article.url !== null && article.title !== null;
    if (article.status === 'verified' && !hasPage) {
      ctx.addIssue({ code: 'custom', message: 'Verified articles need a title, page ID and URL.' });
    }
    if (article.status === 'missing' && (article.title !== null || article.url !== null)) {
      ctx.addIssue({ code: 'custom', message: 'Missing articles must not carry a title or URL.' });
    }
  });
export type LanguageArticle = z.infer<typeof LanguageArticleSchema>;

export const ResolveResultSchema = z
  .object({
    topic: z.string(),
    status: z.enum(['resolved', 'ambiguous', 'not_found']),
    reason: z.enum(['exact_title', 'disambiguation_page', 'no_exact_match', 'no_results']),
    sourceLanguage: z.string(),
    source: SourceArticleSchema.nullable(),
    articles: z.array(LanguageArticleSchema),
    /** Requested editions without a verified article (statuses other than `verified`). */
    missingLanguages: z.array(z.string()),
    candidates: z.array(CandidateSchema),
    /** What the agent should do next. */
    nextStep: z.string(),
  })
  .strict()
  .superRefine((result, ctx) => {
    if ((result.status === 'resolved') !== (result.source !== null)) {
      ctx.addIssue({ code: 'custom', path: ['source'], message: 'A source article is present only when resolved.' });
    }
    if (result.status !== 'resolved' && result.articles.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['articles'], message: 'Language articles are listed only when resolved.' });
    }
  });
export type ResolveResult = z.infer<typeof ResolveResultSchema>;
