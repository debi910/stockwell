import { describe, expect, it } from 'vitest';
import { addDays, financialYear, monthRange, parseDate } from '../../src/core/dates';

describe('dates', () => {
  it('parses short Indian dates', () => {
    expect(parseDate('2-11-26')).toBe('2026-11-02');
    expect(parseDate('02/11/2026')).toBe('2026-11-02');
    expect(parseDate('5', '2026-11-02')).toBe('2026-11-05');
    expect(parseDate('5-nov', '2026-01-02')).toBe('2026-11-05');
    expect(parseDate('31-2-26')).toBeNull();
  });
  it('finds the financial year', () => {
    expect(financialYear('2026-11-02')).toEqual({ start: '2026-04-01', end: '2027-03-31', label: '2026-27' });
    expect(financialYear('2027-02-10').label).toBe('2026-27');
  });
  it('handles month ranges and adding days', () => {
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(addDays('2026-10-25', 10)).toBe('2026-11-04');
  });
});
