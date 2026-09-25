import { describe, expect, it } from 'vitest';
import { extractIsoYears, extractNumbers, isSupported } from '../../src/report/numbers.ts';

const values = (text: string) => extractNumbers(text).map((token) => token.readings.map((reading) => reading.value));

describe('extractNumbers', () => {
  it('reads locale formats', () => {
    expect(values('25,473 views')).toEqual([[25473, 25.473]]);
    expect(values('25 473 і 25 473')).toEqual([[25473], [25473]]);
    expect(values('−59,74 % and 59.74%')).toEqual([[59.74], [59.74]]);
    expect(values('1.234.567 odsłon')).toEqual([[1234567]]);
    expect(values('1,234.5')).toEqual([[1234.5]]);
  });

  it('removes ISO dates and period IDs before extraction', () => {
    expect(values('from 2024-01-01 to 2024-12 in compare-1')).toEqual([]);
    expect(extractIsoYears('2024-01-01 and 2025-06')).toEqual([2024, 2025]);
  });
});

describe('isSupported', () => {
  it('accepts exact and rounded values but not others', () => {
    const [token] = extractNumbers('59,7');
    expect(isSupported(token!, [-59.74])).toBe(true);
    expect(isSupported(extractNumbers('60')[0]!, [59.74])).toBe(true);
    expect(isSupported(extractNumbers('59,8')[0]!, [59.74])).toBe(false);
    expect(isSupported(extractNumbers('35')[0]!, [22.98, 59.74])).toBe(false);
  });
});
