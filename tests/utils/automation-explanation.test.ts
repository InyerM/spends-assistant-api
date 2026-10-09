import { describe, expect, it } from 'vitest';
import {
  explanationFingerprint,
  normalizeExplanationRule
} from '../../src/utils/automation-explanation';
const rule = {
  name: 'Coffee',
  rule_type: 'general',
  condition_logic: 'or',
  conditions: { raw_text_contains: ['coffee'] },
  actions: { add_note: 'Reviewed' }
};
describe('automation explanation identity', () => {
  it('ignores row metadata and object key order but refreshes changed behavior', async () => {
    const first = normalizeExplanationRule(rule);
    const reordered = normalizeExplanationRule({
      ...rule,
      id: 'row',
      updated_at: 'later',
      actions: { add_note: 'Reviewed' }
    });
    expect(await explanationFingerprint(first, [], [])).toBe(
      await explanationFingerprint(reordered, [], [])
    );
    expect(await explanationFingerprint(first, [], [])).not.toBe(
      await explanationFingerprint(
        normalizeExplanationRule({ ...rule, condition_logic: 'and' }),
        [],
        []
      )
    );
    expect(await explanationFingerprint(first, [{ id: 'one', name: 'Bank' }], [])).not.toBe(
      await explanationFingerprint(first, [{ id: 'one', name: 'Renamed bank' }], [])
    );
  });
  it('rejects invalid or oversized draft input before external AI', () => {
    expect(() => normalizeExplanationRule(null)).toThrow();
    expect(() => normalizeExplanationRule({ ...rule, name: 'x'.repeat(201) })).toThrow();
    expect(() => normalizeExplanationRule({ ...rule, conditions: [] })).toThrow();
  });
});
