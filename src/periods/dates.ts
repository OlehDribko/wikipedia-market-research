/** Inclusive calendar date range in ISO format (YYYY-MM-DD), interpreted in UTC. */
export interface DateRange {
  start: string;
  end: string;
}

/** Whether a user-supplied bound opens or closes a range. `YYYY-MM` expands differently for each. */
export type DateRole = 'start' | 'end';

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

export function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Parses `YYYY-MM-DD` or `YYYY-MM` into an ISO date.
 * A month expands to its first day for a start bound and its last day for an end bound.
 * Returns null for malformed input or impossible calendar dates (e.g. 2025-02-30).
 */
export function parseDateBound(value: string, role: DateRole): string | null {
  const text = value.trim();

  const day = DAY_PATTERN.exec(text);
  if (day) {
    const year = Number(day[1]);
    const month = Number(day[2]);
    const dayOfMonth = Number(day[3]);
    if (month < 1 || month > 12) return null;
    if (dayOfMonth < 1 || dayOfMonth > daysInMonth(year, month)) return null;
    return text;
  }

  const month = MONTH_PATTERN.exec(text);
  if (month) {
    const year = Number(month[1]);
    const monthNumber = Number(month[2]);
    if (monthNumber < 1 || monthNumber > 12) return null;
    const dayOfMonth = role === 'start' ? 1 : daysInMonth(year, monthNumber);
    return `${month[1]}-${month[2]}-${pad2(dayOfMonth)}`;
  }

  return null;
}

/** True when the range starts on the first day of a month and ends on the last day of a month. */
export function isMonthAligned(range: DateRange): boolean {
  const [endYear, endMonth, endDay] = range.end.split('-').map(Number);
  if (endYear === undefined || endMonth === undefined || endDay === undefined) return false;
  return range.start.endsWith('-01') && endDay === daysInMonth(endYear, endMonth);
}
