/**
 * Detection of numeric claims in free text, tolerant of locale formats:
 * "25,473" / "25 473" / "25.473" (thousands), "59.74" / "59,74" (decimals), "−59,7 %", "3.2×".
 */

export interface NumericToken {
  raw: string;
  /** Possible values (absolute), each with the number of decimals written. */
  readings: { value: number; decimals: number }[];
}

const TOKEN = /\d+(?:[.,    ]\d+)*/g;
const GROUPS_OF_THREE = /^\d{1,3}(?:[.,]\d{3})+$/;

function reading(integerPart: string, fraction: string): { value: number; decimals: number } {
  return { value: Number(`${integerPart}.${fraction || '0'}`), decimals: fraction.length };
}

/** Interprets one token: spaces are always group separators; "." and "," may be either. */
function readings(raw: string): NumericToken['readings'] {
  const compact = raw.replace(/[    ]/g, '');
  const hasDot = compact.includes('.');
  const hasComma = compact.includes(',');
  if (!hasDot && !hasComma) return [{ value: Number(compact), decimals: 0 }];

  if (hasDot && hasComma) {
    const decimalSeparator = compact.lastIndexOf('.') > compact.lastIndexOf(',') ? '.' : ',';
    const [integerPart = '', fraction = ''] = compact.split(decimalSeparator);
    return [reading(integerPart.replace(/[.,]/g, ''), fraction)];
  }

  const separator = hasDot ? '.' : ',';
  const parts = compact.split(separator);
  const options: NumericToken['readings'] = [];
  if (GROUPS_OF_THREE.test(compact)) options.push({ value: Number(parts.join('')), decimals: 0 });
  if (parts.length === 2) options.push(reading(parts[0] as string, parts[1] as string));
  return options;
}

/** ISO dates/months and period IDs are handled separately and removed before extracting numbers. */
const ISO_DATE = /\b(\d{4})-(\d{2})(?:-(\d{2}))?\b/g;
const PERIOD_ID = /\bcompare-\d+\b/g;

export function extractIsoYears(text: string): number[] {
  return [...text.matchAll(ISO_DATE)].map((match) => Number(match[1]));
}

export function extractNumbers(text: string): NumericToken[] {
  const cleaned = text.replace(ISO_DATE, ' ').replace(PERIOD_ID, ' ');
  return [...cleaned.matchAll(TOKEN)].map((match) => ({ raw: match[0], readings: readings(match[0]) }));
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(Math.abs(value) * factor) / factor;
}

/** True when the token equals one of the allowed values rounded to the precision the text uses. */
export function isSupported(token: NumericToken, allowed: readonly number[]): boolean {
  return token.readings.some(({ value, decimals }) => allowed.some((candidate) => Math.abs(roundTo(candidate, decimals) - value) < 1e-9));
}
