import { expect, it } from 'vitest';
import { automationGenerateSystemPrompt } from '../../src/constants/automation-generate-system-prompt';
import { automationExplanationSystemPrompt } from '../../src/constants/automation-explanation-system-prompt';
it.each([automationGenerateSystemPrompt, automationExplanationSystemPrompt])(
  'documents the actual bounded engine contract',
  (prompt) => {
    expect(prompt).toContain('RE2');
    expect(prompt).toContain('Unicode');
    expect(prompt).toContain('512');
    expect(prompt).toContain('lookaround');
    expect(prompt).toContain('backreferences');
  }
);

it('omits the whole rule with a falsy malformed expression from AI guidance', async () => {
  const { buildAutomationRulesPromptSection } = await import(
    '../../src/services/transfer-processor'
  );
  const { createMockAutomationRule } = await import('../__test-helpers__/factories');
  expect(
    buildAutomationRulesPromptSection([
      createMockAutomationRule({
        conditions: { description_regex: 0 as unknown as string },
        actions: { set_category: 'synthetic' }
      })
    ])
  ).toBe('');
});
