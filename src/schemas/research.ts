import { z } from 'zod';
import { AnalysisSchema } from './analysis.ts';
import { WarningSchema } from './envelope.ts';
import { ObservationSchema, ObservationStatusSchema } from './observation.ts';
import { ResolveResultSchema } from './resolve.ts';

/** 2: `analysis` holds the statistical analysis (stage 4). */
export const RESEARCH_ARTIFACT_FORMAT = 2;

const StatusCountsSchema = z.record(ObservationStatusSchema, z.number().int().nonnegative());

export const PlannedPeriodSchema = z.object({ id: z.string(), start: z.iso.date(), end: z.iso.date() }).strict();

export const PeriodQualitySchema = z
  .object({
    periodId: z.string(),
    units: z.number().int().nonnegative(),
    expected: z.number().int().nonnegative(),
    counted: z.number().int().nonnegative(),
    coverage: z.number().min(0).max(1).nullable(),
    counts: StatusCountsSchema,
  })
  .strict();

/** One request made (or served from cache) for a dataset. */
export const DatasetRequestSchema = z
  .object({
    start: z.iso.date(),
    end: z.iso.date(),
    url: z.string(),
    outcome: z.enum(['ok', 'no_data', 'error', 'skipped_before_creation']),
    rows: z.number().int().nonnegative().nullable(),
    cache: z.enum(['hit', 'miss', 'bypass', 'none']),
    fetchedAt: z.iso.datetime().nullable(),
    error: z.string().nullable(),
  })
  .strict();

export const DatasetSchema = z
  .object({
    lang: z.string(),
    project: z.string(),
    title: z.string(),
    pageId: z.number().int(),
    url: z.string(),
    wikidataId: z.string().nullable(),
    createdAt: z.iso.datetime().nullable(),
    creationSource: z.enum(['mediawiki_first_revision', 'unknown']),
    granularity: z.enum(['daily', 'monthly']),
    agent: z.literal('user'),
    access: z.literal('all-access'),
    publishedThrough: z.iso.date(),
    requests: z.array(DatasetRequestSchema),
    observations: z.array(ObservationSchema),
    quality: z
      .object({ counts: StatusCountsSchema, uncertain: z.number().int().nonnegative(), byPeriod: z.array(PeriodQualitySchema) })
      .strict(),
  })
  .strict();
export type Dataset = z.infer<typeof DatasetSchema>;

/** Complete research result saved by `research` and consumed by later stages (analysis, report). */
export const ResearchArtifactSchema = z
  .object({
    format: z.literal(RESEARCH_ARTIFACT_FORMAT),
    id: z.string().regex(/^[0-9a-f]{12}$/),
    generatedAt: z.iso.datetime(),
    tool: z.object({ name: z.literal('wikipedia-market-research'), version: z.string() }).strict(),
    request: z
      .object({
        subject: z.union([
          z.object({ kind: z.literal('topic'), topic: z.string(), lang: z.string() }).strict(),
          z.object({ kind: z.literal('article'), lang: z.string(), title: z.string() }).strict(),
        ]),
        languages: z.array(z.string()),
        periodMode: z.enum(['explicit', 'comparisons', 'default']),
        requestedGranularity: z.enum(['auto', 'daily', 'monthly']),
        useCache: z.boolean(),
      })
      .strict(),
    plan: z
      .object({
        today: z.iso.date(),
        periods: z.array(PlannedPeriodSchema).min(1),
        granularity: z.enum(['daily', 'monthly']),
        granularityReason: z.string(),
      })
      .strict(),
    resolution: ResolveResultSchema,
    datasets: z.array(DatasetSchema),
    unavailableLanguages: z.array(z.object({ lang: z.string(), status: z.string(), title: z.string().nullable() }).strict()),
    warnings: z.array(WarningSchema),
    limitations: z.array(z.string()),
    analysis: AnalysisSchema,
    sources: z.array(z.string()),
  })
  .strict();
export type ResearchArtifact = z.infer<typeof ResearchArtifactSchema>;
