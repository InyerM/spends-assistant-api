import { describe, it, expect } from 'vitest';
import { isValidDate, isValidTime, isValidAmount, isValidEmail } from '../../src/utils/validation';

describe('isValidDate', () => {
  it('accepts valid YYYY-MM-DD', () => {
    expect(isValidDate('2024-01-15')).toBe(true);
  });

  it('rejects invalid format', () => {
    expect(isValidDate('15/01/2024')).toBe(false);
  });

  it('rejects invalid month', () => {
    expect(isValidDate('2024-13-01')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidDate('')).toBe(false);
  });
});

describe('isValidTime', () => {
  it('accepts valid HH:mm', () => {
    expect(isValidTime('14:30')).toBe(true);
  });

  it('accepts midnight 00:00', () => {
    expect(isValidTime('00:00')).toBe(true);
  });

  it('accepts 23:59', () => {
    expect(isValidTime('23:59')).toBe(true);
  });

  it('rejects 24:00', () => {
    expect(isValidTime('24:00')).toBe(false);
  });

  it('rejects 12:60', () => {
    expect(isValidTime('12:60')).toBe(false);
  });

  it('rejects invalid format', () => {
    expect(isValidTime('2:30')).toBe(false);
  });
});

describe('isValidAmount', () => {
  it('accepts positive number', () => {
    expect(isValidAmount(50000)).toBe(true);
  });

  it('rejects zero', () => {
    expect(isValidAmount(0)).toBe(false);
  });

  it('rejects negative', () => {
    expect(isValidAmount(-100)).toBe(false);
  });

  it('rejects Infinity', () => {
    expect(isValidAmount(Infinity)).toBe(false);
  });

  it('rejects NaN', () => {
    expect(isValidAmount(NaN)).toBe(false);
  });
});

describe('isValidEmail', () => {
  it('accepts valid email', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
  });

  it('rejects missing @', () => {
    expect(isValidEmail('userexample.com')).toBe(false);
  });

  it('rejects missing domain', () => {
    expect(isValidEmail('user@')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidEmail('')).toBe(false);
  });
});
