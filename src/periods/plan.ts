import type { ResearchPeriod } from '../schemas/inputs.ts';
import {
  addDays,
  addMonths,
  enumerateDays,
  enumerateMonths,
  isMonthAligned,
  monthEnd,
  type DateRange,
} from './dates.ts';

export type FetchGranularity = 'daily' | 'monthly';

export interface PlannedPeriod extends DateRange {
  /** `main` for --start/--end or the default period; `compare-1`, `compare-2`, … for --compare ranges. */
  id: string;
}

export interface PeriodPlan {
  mode: ResearchPeriod['mode'];
  periods: PlannedPeriod[];
  granularity: FetchGranularity;
  granularityReason: string;
  /** Current UTC date; every unit ending on or after it is incomplete. */
  today: string;
}

/** The last 12 completed calendar months before the month containing `today`. */
export function defaultPeriod(today: string): DateRange {
  const lastMonth = addMonths(today, -1);
  return { start: addMonths(lastMonth, -11), end: monthEnd(lastMonth) };
}

export function planPeriods(
  request: { period: ResearchPeriod; comparisons: DateRange[] | null; granularity: 'auto' | FetchGranularity },
  today: string,
): PeriodPlan {
  const periods: PlannedPeriod[] = [];
  if (request.period.mode === 'explicit') periods.push({ id: 'main', ...request.period.range });
  if (request.period.mode === 'default') periods.push({ id: 'main', ...defaultPeriod(today) });
  (request.comparisons ?? []).forEach((range, index) => periods.push({ id: `compare-${index + 1}`, ...range }));

  if (periods.length === 0) throw new Error('A research plan needs at least one period.');

  let granularity: FetchGranularity;
  let granularityReason: string;
  if (request.granularity !== 'auto') {
    granularity = request.granularity;
    granularityReason = `${granularity === 'daily' ? 'Daily' : 'Monthly'} granularity was requested.`;
  } else if (periods.every(isMonthAligned)) {
    granularity = 'monthly';
    granularityReason = 'All periods cover whole calendar months.';
  } else {
    granularity = 'daily';
    granularityReason = 'At least one period does not cover whole calendar months, so exact daily data is used.';
  }

  return { mode: request.period.mode, periods, granularity, granularityReason, today };
}

/** Start date of every unit (day or month) covered by any period, sorted and unique. */
export function unitsFor(periods: readonly DateRange[], granularity: FetchGranularity): string[] {
  const units = new Set<string>();
  for (const period of periods) {
    for (const unit of granularity === 'daily' ? enumerateDays(period) : enumerateMonths(period)) units.add(unit);
  }
  return [...units].sort();
}

export function unitEnd(unit: string, granularity: FetchGranularity): string {
  return granularity === 'daily' ? unit : monthEnd(unit);
}

/** Last day that can hold complete data: yesterday (daily) or the end of the previous month (monthly). */
export function completeCeiling(today: string, granularity: FetchGranularity): string {
  return granularity === 'daily' ? addDays(today, -1) : addDays(`${today.slice(0, 7)}-01`, -1);
}
