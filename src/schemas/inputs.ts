import { z } from 'zod';
import { isMonthAligned, type DateRange } from '../periods/dates.ts';
import {
  ArticleRefSchema,
  ComparisonRangesSchema,
  EndDateSchema,
  GranularitySchema,
  LanguageCodeSchema,
  LanguageListSchema,
  StartDateSchema,
  TopicSchema,
  type ArticleRef,
  type Granularity,
} from './common.ts';

function required(option: string, example: string) {
  return (issue: { input: unknown }) =>
    issue.input === undefined ? `--${option} is required, e.g. --${option} ${example}.` : undefined;
}

// ---------------------------------------------------------------------------
// research
// ---------------------------------------------------------------------------

export type ResearchSubject =
  | { kind: 'topic'; topic: string; lang: string }
  | ({ kind: 'article' } & ArticleRef);

/**
 * - `explicit`: the user's --start/--end range.
 * - `comparisons`: only the --compare ranges are analyzed; no extra period is added.
 * - `default`: no period given at all → last 12 completed calendar months, resolved at run time.
 */
export type ResearchPeriod =
  | { mode: 'explicit'; range: DateRange }
  | { mode: 'comparisons' }
  | { mode: 'default' };

export interface ResearchRequest {
  subject: ResearchSubject;
  languages: string[];
  period: ResearchPeriod;
  comparisons: DateRange[] | null;
  granularity: Granularity;
  outDir: string;
  useCache: boolean;
}

export const ResearchInputSchema = z
  .object({
    topic: TopicSchema.optional(),
    lang: LanguageCodeSchema.optional(),
    article: ArticleRefSchema.optional(),
    langs: z.string({ error: required('langs', 'en,de,uk') }).pipe(LanguageListSchema),
    start: StartDateSchema.optional(),
    end: EndDateSchema.optional(),
    compare: ComparisonRangesSchema.optional(),
    granularity: GranularitySchema.default('auto'),
    out: z.string().trim().min(1, '--out must not be empty.').default('output'),
    'no-cache': z.boolean().default(false),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.topic !== undefined && input.article !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['article'], message: 'Use either --topic or --article, not both.' });
    }
    if (input.topic === undefined && input.article === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['topic'],
        message: 'Provide --topic with --lang, or --article (e.g. --article en:Intermittent_fasting).',
      });
    }
    if (input.topic !== undefined && input.lang === undefined) {
      ctx.addIssue({ code: 'custom', path: ['lang'], message: '--lang is required with --topic (language of the topic text).' });
    }
    if (input.article !== undefined && input.lang !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['lang'],
        message: '--lang is only used with --topic; --article already includes the language.',
      });
    }
    if ((input.start === undefined) !== (input.end === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [input.start === undefined ? 'start' : 'end'],
        message: 'Provide both --start and --end, or neither (then --compare ranges, or the last 12 completed calendar months, are used).',
      });
    }
    if (input.start !== undefined && input.end !== undefined && input.start > input.end) {
      ctx.addIssue({ code: 'custom', path: ['end'], message: '--end must not be earlier than --start.' });
    }
    if (input.granularity === 'monthly') {
      const ranges = [...(input.start && input.end ? [{ start: input.start, end: input.end }] : []), ...(input.compare ?? [])];
      if (!ranges.every(isMonthAligned)) {
        ctx.addIssue({
          code: 'custom',
          path: ['granularity'],
          message: 'Monthly granularity requires every range to cover whole calendar months. Use --granularity daily or auto.',
        });
      }
    }
  })
  .transform((input): ResearchRequest => {
    // superRefine guarantees exactly one subject and paired start/end.
    const subject: ResearchSubject =
      input.article !== undefined
        ? { kind: 'article', ...input.article }
        : { kind: 'topic', topic: input.topic as string, lang: input.lang as string };
    const period: ResearchPeriod =
      input.start !== undefined && input.end !== undefined
        ? { mode: 'explicit', range: { start: input.start, end: input.end } }
        : input.compare !== undefined
          ? { mode: 'comparisons' }
          : { mode: 'default' };

    return {
      subject,
      languages: input.langs,
      period,
      comparisons: input.compare ?? null,
      granularity: input.granularity,
      outDir: input.out,
      useCache: !input['no-cache'],
    };
  });

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

export interface ResolveRequest {
  topic: string;
  lang: string;
  languages: string[] | null;
  limit: number;
}

export const ResolveInputSchema = z
  .object({
    topic: z.string({ error: required('topic', '"Intermittent fasting"') }).pipe(TopicSchema),
    lang: z.string({ error: required('lang', 'en') }).pipe(LanguageCodeSchema),
    langs: LanguageListSchema.optional(),
    limit: z
      .string()
      .regex(/^\d+$/, '--limit must be a whole number.')
      .transform(Number)
      .pipe(z.number().int().min(1, '--limit must be at least 1.').max(10, '--limit must be at most 10.'))
      .default(5),
  })
  .strict()
  .transform(
    (input): ResolveRequest => ({
      topic: input.topic,
      lang: input.lang,
      languages: input.langs ?? null,
      limit: input.limit,
    }),
  );

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

export interface ReportRequest {
  researchPath: string;
  conclusionsPath: string;
  outPath: string | null;
}

function pathWithExtension(option: string, extension: string, example: string) {
  return z
    .string({ error: required(option, example) })
    .trim()
    .min(1, `--${option} must not be empty.`)
    .refine((value) => value.toLowerCase().endsWith(extension), `--${option} must point to a ${extension} file.`);
}

export const ReportInputSchema = z
  .object({
    research: pathWithExtension('research', '.json', 'output/research-<id>.json'),
    conclusions: pathWithExtension('conclusions', '.json', 'output/conclusions.json'),
    out: pathWithExtension('out', '.pdf', 'output/report.pdf').optional(),
  })
  .strict()
  .transform(
    (input): ReportRequest => ({
      researchPath: input.research,
      conclusionsPath: input.conclusions,
      outPath: input.out ?? null,
    }),
  );
