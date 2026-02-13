import { describe, it, expect } from 'vitest';
import { formatCurrency, capitalize, formatConfidence } from '../../src/utils/formatting';

describe('formatCurrency', () => {
  it('formats zero', () => {
    const result = formatCurrency(0);
    expect(result).toContain('0');
  });

  it('formats a typical amount', () => {
    const result = formatCurrency(50000);
    expect(result).toContain('50');
  });

  it('formats a large amount with separators', () => {
    const result = formatCurrency(1500000);
    expect(result).toContain('1');
    expect(result).toContain('500');
  });

  it('includes COP currency symbol', () => {
    const result = formatCurrency(100);
    expect(result).toMatch(/\$|COP/);
  });
});

describe('capitalize', () => {
  it('capitalizes first letter of each word', () => {
    expect(capitalize('hello world')).toBe('Hello World');
  });

  it('handles empty string', () => {
    expect(capitalize('')).toBe('');
  });

  it('handles single word', () => {
    expect(capitalize('hello')).toBe('Hello');
  });
});

describe('formatConfidence', () => {
  it('formats a number as percentage', () => {
    expect(formatConfidence(95)).toBe('95%');
  });

  it('rounds decimal values', () => {
    expect(formatConfidence(95.7)).toBe('96%');
  });

  it('returns N/A for null', () => {
    expect(formatConfidence(null)).toBe('N/A');
  });

  it('returns N/A for undefined', () => {
    expect(formatConfidence(undefined as unknown as null)).toBe('N/A');
  });
});
