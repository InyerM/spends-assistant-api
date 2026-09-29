import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../../src/constants/parse-expens-system-prompt';

const prompt = buildSystemPrompt('2026-09-28', '10:30');

describe('parse expense system prompt', () => {
  it('gives an unambiguous Bancolombia source rule based on channel evidence', () => {
    expect(prompt).toContain('bancolombia_sms');
    expect(prompt).toContain('bancolombia_email');
    expect(prompt).toContain('Email headers or explicit email channel');
    expect(prompt).not.toContain('Ban colombiatext');
  });

  it('does not label every Nequi purchase as a transfer payment', () => {
    expect(prompt).toContain('Nequi: Pagaste $X en Y');
    expect(prompt).toContain('Nequi: Enviaste $X a Y');
    expect(prompt).toContain('If the payment method is not stated, use "unknown"');
    expect(prompt).not.toContain('- Nequi → "transfer"');
  });

  it('does not force a specific category when the text provides no evidence', () => {
    expect(prompt).toContain('If the evidence is insufficient, choose "missing"');
    expect(prompt).not.toContain('If unsure between categories, choose the more specific one');
  });
});
