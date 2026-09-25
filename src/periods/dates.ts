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

// ---------------------------------------------------------------------------
// Calendar arithmetic on ISO dates (UTC). Inputs are assumed valid YYYY-MM-DD.
// ---------------------------------------------------------------------------

function toUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function fromUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function todayUtc(now: Date): string {
  return fromUtc(now);
}

export function addDays(iso: string, days: number): string {
  const date = toUtc(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return fromUtc(date);
}

export function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function monthEnd(iso: string): string {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  return `${iso.slice(0, 7)}-${String(daysInMonth(year, month)).padStart(2, '0')}`;
}

/** First day of the month `months` months away from the month containing `iso`. */
export function addMonths(iso: string, months: number): string {
  const date = toUtc(monthStart(iso));
  date.setUTCMonth(date.getUTCMonth() + months);
  return fromUtc(date);
}

/** Every day from start to end, inclusive. */
export function enumerateDays(range: DateRange): string[] {
  const days: string[] = [];
  for (let day = range.start; day <= range.end; day = addDays(day, 1)) days.push(day);
  return days;
}

/** First day of every month touched by the range, inclusive. */
export function enumerateMonths(range: DateRange): string[] {
  const months: string[] = [];
  for (let month = monthStart(range.start); month <= range.end; month = addMonths(month, 1)) months.push(month);
  return months;
}

/** `2025-01-31` → `20250131`, the date format of the Wikimedia pageviews API. */
export function toCompactDate(iso: string): string {
  return iso.replaceAll('-', '');
}

/** `2025013100` (YYYYMMDDHH) → `2025-01-31`. Returns null for malformed timestamps. */
export function fromApiTimestamp(timestamp: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})\d{2}$/.exec(timestamp);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  return parseDateBound(iso, 'start') === iso ? iso : null;
}
