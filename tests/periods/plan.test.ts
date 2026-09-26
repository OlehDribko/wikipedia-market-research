import { describe, expect, it } from 'vitest';
import { addDays, addMonths, enumerateDays, enumerateMonths, fromApiTimestamp, monthEnd, todayUtc } from '../../src/periods/dates.ts';
import { completeCeiling, defaultPeriod, planPeriods, unitEnd, unitLabel, unitsFor } from '../../src/periods/plan.ts';

describe('calendar helpers', () => {
  it('handles month and year boundaries and leap years', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2025-01-01', -1)).toBe('2024-12-31');
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-01');
    expect(addMonths('2025-01-15', -1)).toBe('2024-12-01');
    expect(monthEnd('2024-02-10')).toBe('2024-02-29');
  });

  it('enumerates inclusive ranges', () => {
    expect(enumerateDays({ start: '2024-12-30', end: '2025-01-02' })).toEqual(['2024-12-30', '2024-12-31', '2025-01-01', '2025-01-02']);
    expect(enumerateDays({ start: '2025-03-05', end: '2025-03-05' })).toEqual(['2025-03-05']);
    expect(enumerateMonths({ start: '2024-11-01', end: '2025-02-28' })).toEqual(['2024-11-01', '2024-12-01', '2025-01-01', '2025-02-01']);
  });

  it('parses API timestamps strictly', () => {
    expect(fromApiTimestamp('2025013100')).toBe('2025-01-31');
    expect(fromApiTimestamp('2025023000')).toBeNull();
    expect(fromApiTimestamp('20250131')).toBeNull();
  });

  it('uses the UTC date', () => {
    expect(todayUtc(new Date('2026-01-01T00:30:00+02:00'))).toBe('2025-12-31');
  });
});

describe('defaultPeriod', () => {
  it('covers the last 12 completed calendar months', () => {
    expect(defaultPeriod('2026-09-25')).toEqual({ start: '2025-09-01', end: '2026-08-31' });
    expect(defaultPeriod('2026-01-01')).toEqual({ start: '2025-01-01', end: '2025-12-31' });
    expect(defaultPeriod('2024-03-31')).toEqual({ start: '2023-03-01', end: '2024-02-29' });
  });
});

describe('planPeriods', () => {
  const today = '2026-09-25';

  it('uses the default period only when nothing was specified', () => {
    const plan = planPeriods({ period: { mode: 'default' }, comparisons: null, granularity: 'auto' }, today);
    expect(plan.periods).toEqual([{ id: 'main', start: '2025-09-01', end: '2026-08-31' }]);
    expect(plan.granularity).toBe('monthly');
  });

  it('adds no default period when only comparisons are given', () => {
    const comparisons = [
      { start: '2024-01-01', end: '2024-06-30' },
      { start: '2025-01-01', end: '2025-06-30' },
    ];
    const plan = planPeriods({ period: { mode: 'comparisons' }, comparisons, granularity: 'auto' }, today);
    expect(plan.periods.map((period) => period.id)).toEqual(['compare-1', 'compare-2']);
    expect(plan.granularity).toBe('monthly');
  });

  it('keeps an explicit period together with comparisons', () => {
    const plan = planPeriods(
      {
        period: { mode: 'explicit', range: { start: '2024-01-01', end: '2025-06-30' } },
        comparisons: [
          { start: '2024-01-01', end: '2024-06-30' },
          { start: '2025-01-01', end: '2025-06-30' },
        ],
        granularity: 'auto',
      },
      today,
    );
    expect(plan.periods.map((period) => period.id)).toEqual(['main', 'compare-1', 'compare-2']);
  });

  it('selects daily data for non-calendar-month ranges', () => {
    const plan = planPeriods({ period: { mode: 'explicit', range: { start: '2025-01-15', end: '2025-02-14' } }, comparisons: null, granularity: 'auto' }, today);
    expect(plan.granularity).toBe('daily');
    expect(plan.granularityReason).toContain('daily');
  });

  it('honours an explicit granularity', () => {
    const plan = planPeriods({ period: { mode: 'default' }, comparisons: null, granularity: 'daily' }, today);
    expect(plan.granularity).toBe('daily');
  });
});

describe('units', () => {
  it('unions overlapping periods without duplicates', () => {
    const units = unitsFor(
      [
        { start: '2025-01-30', end: '2025-02-02' },
        { start: '2025-02-01', end: '2025-02-03' },
      ],
      'daily',
    );
    expect(units).toEqual(['2025-01-30', '2025-01-31', '2025-02-01', '2025-02-02', '2025-02-03']);
  });

  it('labels monthly units as whole months and daily units as days', () => {
    expect(unitLabel('2025-11-01', 'monthly')).toBe('2025-11');
    expect(unitLabel('2025-11-01', 'daily')).toBe('2025-11-01');
  });

  it('computes unit ends and the last complete day', () => {
    expect(unitEnd('2024-02-01', 'monthly')).toBe('2024-02-29');
    expect(unitEnd('2024-02-01', 'daily')).toBe('2024-02-01');
    expect(completeCeiling('2026-09-25', 'daily')).toBe('2026-09-24');
    expect(completeCeiling('2026-09-25', 'monthly')).toBe('2026-08-31');
    expect(completeCeiling('2026-03-01', 'monthly')).toBe('2026-02-28');
  });
});
