import { describe, expect, it } from 'vitest';
import {
  inspectAutomationRegex,
  matchesAutomationRegex,
  assertAutomationRuleSet,
  MAX_AUTOMATION_RULES
} from '../../src/utils/automation-regex';

describe('bounded non-backtracking automation expressions', () => {
  it.each([
    ['^Nomina.*', 'NOMINA synthetic', true],
    ['café', 'CAFÉ', true],
    ['\\d{4}', 'card 1234', true],
    ['(?:coffee|tea)', 'TEA', true],
    ['^food$', 'seafood', false]
  ])('keeps ordinary matching semantics for %s', (pattern, input, expected) => {
    expect(matchesAutomationRegex(pattern, input)).toBe(expected);
    expect(inspectAutomationRegex(pattern).requires_review).toBe(false);
  });
  it.each(['(?=a)a', '(a)\\1', '(?i)alpha', '[', 'a{1000}', '(a{32}){32}'])(
    'requires review for unsupported or oversized %s',
    (pattern) => {
      expect(inspectAutomationRegex(pattern).requires_review).toBe(true);
      expect(matchesAutomationRegex(pattern, 'aaaa')).toBe(false);
    }
  );
  it('does not silently truncate pattern or input', () => {
    expect(inspectAutomationRegex('x'.repeat(513)).requires_review).toBe(true);
    expect(matchesAutomationRegex('^a+$', 'a'.repeat(8193))).toBe(false);
  });
  it('uses the explicit Unicode/RE2 contract rather than claiming JavaScript i identity', () => {
    expect(matchesAutomationRegex('k', 'K')).toBe(true);
    expect(matchesAutomationRegex('^.$', '😀')).toBe(true);
    expect(matchesAutomationRegex('\\s', '\u00a0')).toBe(false);
  });
  it('preserves empty or absent optional expressions but fails closed on invalid value types', () => {
    expect(inspectAutomationRegex(undefined).requires_review).toBe(false);
    expect(inspectAutomationRegex(null).requires_review).toBe(false);
    expect(matchesAutomationRegex('', 'anything')).toBe(true);
    expect(inspectAutomationRegex(17).requires_review).toBe(true);
  });
  it('rejects the whole oversized set instead of dropping later precedence rules', () => {
    expect(() =>
      assertAutomationRuleSet(
        Array.from({ length: MAX_AUTOMATION_RULES + 1 }, () => ({ conditions: {} }))
      )
    ).toThrow('Automation matching requires review');
  });
  it('bounds aggregate compiled work before applying any rules', () => {
    expect(() =>
      assertAutomationRuleSet(
        Array.from({ length: 200 }, (_, index) => ({
          conditions: { description_regex: `^synthetic-${index}.*` }
        }))
      )
    ).toThrow('Automation matching requires review');
  });
});

it('maps only known review errors to a bounded 422 response', async () => {
  const { automationMatchingErrorResponse, AutomationMatchingReviewRequiredError } = await import(
    '../../src/utils/automation-regex'
  );
  const response = automationMatchingErrorResponse(
    new AutomationMatchingReviewRequiredError('rule_limit')
  );
  expect(response?.status).toBe(422);
  expect(await response?.json()).toEqual({
    error: 'Automation matching requires review',
    code: 'AUTOMATION_MATCHING_REVIEW_REQUIRED',
    reason: 'rule_limit',
    requires_review: true
  });
  expect(
    automationMatchingErrorResponse(Object.assign(new Error('private'), { status: 422 }))
  ).toBeNull();
});
