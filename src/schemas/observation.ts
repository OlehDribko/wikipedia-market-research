import { z } from 'zod';

/**
 * Status of one expected observation (day or month) in a pageview series.
 * Missing data is never silently converted to zero; see PROJECT_PLAN.md §5.
 */
export const ObservationStatusSchema = z.enum([
  'observed',
  'zero_omitted',
  'before_creation',
  'unavailable',
  'incomplete',
  'api_error',
]);
export type ObservationStatus = z.infer<typeof ObservationStatusSchema>;

/** `established`: proven by API/MediaWiki evidence. `uncertain`: consistent with the evidence but not proven. */
export const CertaintySchema = z.enum(['established', 'uncertain']);
export type Certainty = z.infer<typeof CertaintySchema>;

/** Statuses that carry a view count; every other status must have `views: null`. */
const COUNTED_STATUSES: ReadonlySet<ObservationStatus> = new Set(['observed', 'zero_omitted']);

export const ObservationSchema = z
  .object({
    /** First day of the unit: YYYY-MM-DD (daily) or YYYY-MM-01 (monthly). */
    period: z.iso.date(),
    views: z.number().int().nonnegative().nullable(),
    status: ObservationStatusSchema,
    certainty: CertaintySchema,
    reason: z.string().min(1),
  })
  .strict()
  .superRefine((observation, ctx) => {
    const counted = COUNTED_STATUSES.has(observation.status);
    if (counted && observation.views === null) {
      ctx.addIssue({ code: 'custom', path: ['views'], message: `Status "${observation.status}" requires a view count.` });
    }
    if (!counted && observation.views !== null) {
      ctx.addIssue({ code: 'custom', path: ['views'], message: `Status "${observation.status}" must have views: null.` });
    }
    if (observation.status === 'zero_omitted' && observation.views !== 0) {
      ctx.addIssue({ code: 'custom', path: ['views'], message: 'Status "zero_omitted" must have views: 0.' });
    }
    if (observation.status === 'observed' && observation.certainty !== 'established') {
      ctx.addIssue({ code: 'custom', path: ['certainty'], message: 'Observed rows are always established.' });
    }
  });
export type Observation = z.infer<typeof ObservationSchema>;
