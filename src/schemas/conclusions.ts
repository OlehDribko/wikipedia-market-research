import { z } from 'zod';

/** Stable ID of a metric in a research artifact, e.g. "de.total" or "en.compare.pctChange". */
export const MetricIdSchema = z
  .string()
  .regex(/^[a-z0-9-]+(?:\.[A-Za-z0-9_-]+)+$/, 'Expected a metric ID such as "de.total".');

const Text = (max: number) => z.string().trim().min(1).max(max);

/**
 * AI-written research conclusions consumed by `report`.
 * The model writes text in the user's language; numbers in the report come only from the artifact.
 * Whether each evidence ID exists is checked against the artifact when the report is built.
 */
export const ConclusionsSchema = z
  .object({
    /** Language of the text, e.g. "uk", "pl", "en" (BCP 47 style). */
    language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, 'Expected a language tag such as "uk" or "en".'),
    headline: Text(160),
    findings: z
      .array(z.object({ statement: Text(500), evidence: z.array(MetricIdSchema).min(1) }).strict())
      .min(1)
      .max(8),
    hypotheses: z
      .array(z.object({ hypothesis: Text(300), validationIdea: Text(300) }).strict())
      .max(5),
    limitations: z.array(Text(300)).min(1).max(8),
    /** Optional translated section headings; English defaults are used for missing keys. */
    labels: z
      .object({
        title: Text(80),
        findings: Text(40),
        hypotheses: Text(40),
        limitations: Text(40),
        metrics: Text(40),
        dataQuality: Text(40),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();
export type Conclusions = z.infer<typeof ConclusionsSchema>;
