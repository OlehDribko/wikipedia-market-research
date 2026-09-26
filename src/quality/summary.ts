import type { PlannedPeriod, FetchGranularity } from '../periods/plan.ts';
import { unitEnd, unitLabel } from '../periods/plan.ts';
import type { Warning } from '../schemas/envelope.ts';
import { UNAVAILABLE_REASON } from './classify.ts';
import { ObservationStatusSchema, type Observation, type ObservationStatus } from '../schemas/observation.ts';

/** Coverage below this share of expected units raises LOW_COVERAGE. */
export const LOW_COVERAGE_THRESHOLD = 0.9;

export type StatusCounts = Record<ObservationStatus, number>;

export interface PeriodQuality {
  periodId: string;
  units: number;
  /** Units that should have data: all except before_creation and incomplete. */
  expected: number;
  /** observed + zero_omitted. Zero-view omissions are not missing data. */
  counted: number;
  /** counted / expected, rounded to 4 decimals; null when nothing is expected. */
  coverage: number | null;
  counts: StatusCounts;
}

export interface DatasetQuality {
  counts: StatusCounts;
  uncertain: number;
  byPeriod: PeriodQuality[];
}

function countStatuses(observations: readonly Observation[]): StatusCounts {
  const counts = Object.fromEntries(ObservationStatusSchema.options.map((status) => [status, 0])) as StatusCounts;
  for (const observation of observations) counts[observation.status]++;
  return counts;
}

export function summarizeQuality(observations: readonly Observation[], periods: readonly PlannedPeriod[], granularity: FetchGranularity): DatasetQuality {
  const byPeriod = periods.map((period): PeriodQuality => {
    const inPeriod = observations.filter((observation) => observation.period >= period.start && unitEnd(observation.period, granularity) <= period.end);
    const counts = countStatuses(inPeriod);
    const expected = inPeriod.length - counts.before_creation - counts.incomplete;
    const counted = counts.observed + counts.zero_omitted;
    return {
      periodId: period.id,
      units: inPeriod.length,
      expected,
      counted,
      coverage: expected > 0 ? Math.round((counted / expected) * 10_000) / 10_000 : null,
      counts,
    };
  });
  return {
    counts: countStatuses(observations),
    uncertain: observations.filter((observation) => observation.certainty === 'uncertain').length,
    byPeriod,
  };
}

function units(count: number, granularity: FetchGranularity): string {
  const word = granularity === 'daily' ? 'day' : 'month';
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function firstWith(observations: readonly Observation[], status: ObservationStatus, reasonPrefix?: string): Observation[] {
  return observations.filter((observation) => observation.status === status && (reasonPrefix === undefined || observation.reason.startsWith(reasonPrefix)));
}

/**
 * Warnings for one language dataset. Clock-based warnings (incomplete, unpublished, before data start)
 * carry no language so that identical ones from several datasets can be merged.
 */
export function qualityWarnings(
  context: { lang: string; title: string; createdOn: string | null; granularity: FetchGranularity },
  observations: readonly Observation[],
  quality: DatasetQuality,
): Warning[] {
  const { lang, title, granularity } = context;
  const warnings: Warning[] = [];
  const range = (list: Observation[]) => `${unitLabel(list[0]?.period ?? '', granularity)} to ${unitLabel(list.at(-1)?.period ?? '', granularity)}`;

  const incomplete = firstWith(observations, 'incomplete');
  if (incomplete.length > 0) {
    warnings.push({
      code: 'INCOMPLETE_PERIOD_EXCLUDED',
      message: `${units(incomplete.length, granularity)} (${range(incomplete)}) are not complete yet and have no values. Use completed periods for comparisons.`,
    });
  }
  const unpublished = firstWith(observations, 'unavailable', UNAVAILABLE_REASON.notPublished);
  if (unpublished.length > 0) {
    warnings.push({ code: 'DATA_NOT_YET_PUBLISHED', message: `${units(unpublished.length, granularity)} (${range(unpublished)}) are not published by Wikimedia yet.` });
  }
  const beforeStart = firstWith(observations, 'unavailable', UNAVAILABLE_REASON.beforeDataStart);
  if (beforeStart.length > 0) {
    warnings.push({ code: 'BEFORE_DATA_AVAILABILITY', message: `${units(beforeStart.length, granularity)} precede Wikimedia pageview data (available from 2015-07-01).` });
  }

  if (context.createdOn === null) {
    warnings.push({ code: 'CREATION_DATE_UNKNOWN', message: `The creation date of "${title}" (${lang}) could not be determined; early gaps stay uncertain.`, language: lang });
  }
  const beforeCreation = firstWith(observations, 'before_creation');
  if (beforeCreation.length > 0) {
    warnings.push({
      code: 'BEFORE_ARTICLE_CREATION',
      message: `"${title}" (${lang}) was created on ${context.createdOn}; ${units(beforeCreation.length, granularity)} before that have no data.`,
      language: lang,
    });
  }
  const zeros = firstWith(observations, 'zero_omitted');
  if (zeros.length > 0) {
    warnings.push({
      code: 'ZERO_VIEWS_INFERRED',
      message: `${units(zeros.length, granularity)} for "${title}" (${lang}) were omitted by Wikimedia and are treated as zero views (uncertain).`,
      language: lang,
    });
  }
  const noData = firstWith(observations, 'unavailable', UNAVAILABLE_REASON.noData);
  if (noData.length > 0) {
    warnings.push({
      code: 'PAGEVIEWS_NO_DATA',
      message: `Wikimedia returned no data (HTTP 404) for ${units(noData.length, granularity)} of "${title}" (${lang}); these are neither zero nor observed.`,
      language: lang,
    });
  }
  const errors = firstWith(observations, 'api_error');
  if (errors.length > 0) {
    warnings.push({
      code: 'PAGEVIEWS_API_ERROR',
      message: `${units(errors.length, granularity)} for "${title}" (${lang}) could not be retrieved: ${errors[0]?.reason}`,
      language: lang,
    });
  }
  for (const period of quality.byPeriod) {
    if (period.coverage !== null && period.coverage < LOW_COVERAGE_THRESHOLD) {
      warnings.push({
        code: 'LOW_COVERAGE',
        message: `Only ${Math.round(period.coverage * 100)}% of expected units have data for "${title}" (${lang}) in period ${period.periodId}.`,
        language: lang,
      });
    }
  }
  return warnings;
}

/** Removes exact duplicates while keeping the first occurrence order. */
export function dedupeWarnings(warnings: readonly Warning[]): Warning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}\u0000${warning.language ?? ''}\u0000${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
