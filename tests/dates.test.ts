import { describe, expect, it } from 'vitest';
import { daysInMonth, isMonthAligned, parseDateBound } from '../src/periods/dates.ts';

describe('parseDateBound', () => {
  it('accepts valid calendar days', () => {
    expect(parseDateBound('2024-02-29', 'start')).toBe('2024-02-29');
    expect(parseDateBound(' 2025-12-31 ', 'end')).toBe('2025-12-31');
  });

  it('expands months by role', () => {
    expect(parseDateBound('2024-02', 'start')).toBe('2024-02-01');
    expect(parseDateBound('2024-02', 'end')).toBe('2024-02-29');
    expect(parseDateBound('2025-02', 'end')).toBe('2025-02-28');
  });

  it.each(['2025-02-29', '2025-13-01', '2025-00', '2025-04-31', '2025/01/01', '2025-1-1', '', 'last year'])(
    'rejects %j',
    (value) => {
      expect(parseDateBound(value, 'start')).toBeNull();
    },
  );
});

describe('daysInMonth', () => {
  it('handles leap years and century rules', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2025, 12)).toBe(31);
  });
});

describe('isMonthAligned', () => {
  it('detects whole calendar months', () => {
    expect(isMonthAligned({ start: '2024-01-01', end: '2024-03-31' })).toBe(true);
    expect(isMonthAligned({ start: '2024-01-01', end: '2024-02-29' })).toBe(true);
  });

  it('rejects partial months', () => {
    expect(isMonthAligned({ start: '2024-01-02', end: '2024-03-31' })).toBe(false);
    expect(isMonthAligned({ start: '2024-01-01', end: '2024-03-30' })).toBe(false);
  });
});
