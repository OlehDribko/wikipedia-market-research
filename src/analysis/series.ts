import { daysInMonth, type DateRange } from '../periods/dates.ts';
import { unitEnd, type FetchGranularity } from '../periods/plan.ts';
import type { Observation } from '../schemas/observation.ts';

/** A unit that counts towards statistics: observed, or an inferred zero-view omission. */
export interface CountedPoint {
  period: string;
  views: number;
  /** True for zero_omitted units: the zero is inferred, not observed. */
  inferred: boolean;
}

export function observationsInPeriod(observations: readonly Observation[], period: DateRange, granularity: FetchGranularity): Observation[] {
  return observations.filter((observation) => observation.period >= period.start && unitEnd(observation.period, granularity) <= period.end);
}

export function isCounted(observation: Observation): boolean {
  return observation.status === 'observed' || observation.status === 'zero_omitted';
}

export function countedPoints(observations: readonly Observation[]): CountedPoint[] {
  return observations.filter(isCounted).map((observation) => ({
    period: observation.period,
    views: observation.views ?? 0,
    inferred: observation.status === 'zero_omitted',
  }));
}

export function daysInUnit(unit: string, granularity: FetchGranularity): number {
  return granularity === 'daily' ? 1 : daysInMonth(Number(unit.slice(0, 4)), Number(unit.slice(5, 7)));
}

export interface WeeklyBlock {
  start: string;
  views: number;
  inferredDays: number;
  /** Days of the block flagged as anomalies. */
  units: string[];
}

/**
 * Consecutive 7-day blocks from the start of a daily period. A block is kept only when all 7 days are counted;
 * a trailing partial block is dropped. Blocks remove the weekday cycle from daily data.
 */
export function weeklyBlocks(periodObservations: readonly Observation[]): { blocks: WeeklyBlock[]; dropped: number } {
  const blocks: WeeklyBlock[] = [];
  let dropped = 0;
  for (let index = 0; index + 7 <= periodObservations.length; index += 7) {
    const days = periodObservations.slice(index, index + 7);
    if (!days.every(isCounted)) {
      dropped++;
      continue;
    }
    blocks.push({
      start: days[0]?.period as string,
      views: days.reduce((total, day) => total + (day.views ?? 0), 0),
      inferredDays: days.filter((day) => day.status === 'zero_omitted').length,
      units: days.map((day) => day.period),
    });
  }
  return { blocks, dropped };
}
