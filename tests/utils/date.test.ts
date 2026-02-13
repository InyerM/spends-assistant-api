import { describe, it, expect } from 'vitest';
import { getCurrentColombiaTimes, convertDateFormat, formatDateForDisplay } from '../../src/utils/date';

describe('getCurrentColombiaTimes', () => {
  it('returns an object with date and time strings', () => {
    const result = getCurrentColombiaTimes();
    expect(result).toHaveProperty('date');
    expect(result).toHaveProperty('time');
  });

  it('returns date in YYYY-MM-DD format', () => {
    const { date } = getCurrentColombiaTimes();
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns time in HH:mm format', () => {
    const { time } = getCurrentColombiaTimes();
    expect(time).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('convertDateFormat', () => {
  it('converts DD/MM/YYYY to YYYY-MM-DD', () => {
    expect(convertDateFormat('15/01/2024')).toBe('2024-01-15');
  });

  it('handles single-digit day/month with leading zero', () => {
    expect(convertDateFormat('03/07/2024')).toBe('2024-07-03');
  });

  it('handles end-of-year date', () => {
    expect(convertDateFormat('31/12/2024')).toBe('2024-12-31');
  });
});

describe('formatDateForDisplay', () => {
  it('converts YYYY-MM-DD to DD/MM/YYYY', () => {
    expect(formatDateForDisplay('2024-01-15')).toBe('15/01/2024');
  });

  it('roundtrips with convertDateFormat', () => {
    const original = '15/06/2024';
    const iso = convertDateFormat(original);
    expect(formatDateForDisplay(iso)).toBe(original);
  });
});
