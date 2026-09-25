import type { DateRange } from '../periods/dates.ts';
import { unitEnd, type FetchGranularity } from '../periods/plan.ts';
import type { Observation } from '../schemas/observation.ts';
import { PAGEVIEWS_DATA_START } from '../wikimedia/pageviews.ts';

/** What happened to the request covering a unit. */
export type ChunkOutcome =
  | { kind: 'ok'; rows: ReadonlyMap<string, number> }
  | { kind: 'no_data' }
  | { kind: 'error'; message: string }
  | { kind: 'skipped_before_creation' };

export interface FetchedChunk extends DateRange {
  outcome: ChunkOutcome;
}

export interface ClassificationInput {
  /** Unit start dates to classify (days, or first days of months), sorted. */
  units: readonly string[];
  granularity: FetchGranularity;
  /** Current UTC date. */
  today: string;
  /** Last day for which Wikimedia has published data for the project. */
  publishedThrough: string;
  /** Article creation date (first revision, UTC day), or null when unknown. */
  createdOn: string | null;
  chunks: readonly FetchedChunk[];
}

/** Reason prefixes that distinguish the causes behind the shared `unavailable` status. */
export const UNAVAILABLE_REASON = {
  beforeDataStart: 'Wikimedia pageview data starts on',
  notPublished: 'Not published by Wikimedia yet',
  noData: 'Wikimedia returned HTTP 404 (no data)',
  unknownCreation: 'Omitted from the response before the first recorded views',
} as const;

const unitWord = (granularity: FetchGranularity) => (granularity === 'daily' ? 'day' : 'month');

/**
 * Assigns every unit exactly one status (PROJECT_PLAN.md §5). Rules, in order:
 * 1. Unit not over yet (UTC)                 → incomplete (established)
 * 2. Before 2015-07-01                         → unavailable (established)
 * 3. Row present in the API response           → observed (established)
 * 4. After the published-data horizon          → unavailable (established)
 * 5. Ends before the article's first revision  → before_creation (established)
 * 6. Otherwise depends on the request outcome:
 *    - error                                   → api_error (established)
 *    - HTTP 404                                → unavailable (uncertain: zero views or missing data)
 *    - omitted from a successful response      → zero_omitted (uncertain), or unavailable (uncertain)
 *      when the creation date is unknown and no earlier row exists
 */
export function classifyObservations(input: ClassificationInput): Observation[] {
  const { granularity, today, publishedThrough, createdOn } = input;
  const word = unitWord(granularity);
  let firstObserved: string | null = null;
  for (const chunk of input.chunks) {
    if (chunk.outcome.kind !== 'ok') continue;
    for (const date of chunk.outcome.rows.keys()) if (firstObserved === null || date < firstObserved) firstObserved = date;
  }

  return input.units.map((unit): Observation => {
    const end = unitEnd(unit, granularity);
    const base = { period: unit };

    if (end >= today) {
      return { ...base, views: null, status: 'incomplete', certainty: 'established', reason: `This ${word} is not complete yet (UTC date ${today}).` };
    }
    if (unit < PAGEVIEWS_DATA_START) {
      return { ...base, views: null, status: 'unavailable', certainty: 'established', reason: `${UNAVAILABLE_REASON.beforeDataStart} ${PAGEVIEWS_DATA_START}.` };
    }

    const chunk = input.chunks.find((candidate) => unit >= candidate.start && unit <= candidate.end);
    const outcome = chunk?.outcome;
    const views = outcome?.kind === 'ok' ? outcome.rows.get(unit) : undefined;
    if (views !== undefined) {
      return { ...base, views, status: 'observed', certainty: 'established', reason: 'Returned by the Wikimedia pageviews API.' };
    }

    if (end > publishedThrough) {
      return {
        ...base,
        views: null,
        status: 'unavailable',
        certainty: 'established',
        reason: `${UNAVAILABLE_REASON.notPublished} (published through ${publishedThrough}).`,
      };
    }
    if (createdOn !== null && end < createdOn) {
      return { ...base, views: null, status: 'before_creation', certainty: 'established', reason: `Before the article was created on ${createdOn} (first revision).` };
    }

    if (!outcome || outcome.kind === 'skipped_before_creation') {
      // Unreachable when chunks are planned correctly; never invent a value.
      return { ...base, views: null, status: 'api_error', certainty: 'established', reason: 'No request covered this unit.' };
    }
    if (outcome.kind === 'error') {
      return { ...base, views: null, status: 'api_error', certainty: 'established', reason: `Request failed: ${outcome.message}` };
    }
    if (outcome.kind === 'no_data') {
      return {
        ...base,
        views: null,
        status: 'unavailable',
        certainty: 'uncertain',
        reason: `${UNAVAILABLE_REASON.noData} for this range; this can mean zero views or missing data.`,
      };
    }
    if (createdOn === null && (firstObserved === null || unit < firstObserved)) {
      return {
        ...base,
        views: null,
        status: 'unavailable',
        certainty: 'uncertain',
        reason: `${UNAVAILABLE_REASON.unknownCreation}; the creation date is unknown, so this may precede the article.`,
      };
    }
    return {
      ...base,
      views: 0,
      status: 'zero_omitted',
      certainty: 'uncertain',
      reason: 'Omitted from a successful response. Wikimedia omits units without any recorded traffic, so zero views are assumed.',
    };
  });
}
