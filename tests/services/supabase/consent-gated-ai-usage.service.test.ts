import { describe, expect, it, vi } from 'vitest';
import { ConsentGatedAiUsageService } from '../../../src/services/supabase/consent-gated-ai-usage.service';
import { AiConsentRequiredError } from '../../../src/services/supabase/ai-consent.service';

const params = { userId: 'owner-1', operation: 'parse_expense' as const, model: 'model-1' };

describe('ConsentGatedAiUsageService', () => {
  it('does not invoke the provider or telemetry when consent is missing', async () => {
    const requireConsent = vi.fn(async () => {
      throw new AiConsentRequiredError('financial_text');
    });
    const provider = vi.fn(async () => 'result');
    const service = new ConsentGatedAiUsageService('https://test.supabase.co', 'key', {
      require: requireConsent
    });
    await expect(
      service.track({ ...params, operation: 'generate_automation' }, provider)
    ).rejects.toBeInstanceOf(AiConsentRequiredError);
    expect(provider).not.toHaveBeenCalled();
    expect(requireConsent).toHaveBeenCalledWith('owner-1', 'financial_text');
  });

  it('uses the email scope for background email analysis', async () => {
    const requireConsent = vi.fn(async (_userId: string, scope: string) => {
      if (scope === 'financial_text') throw new AiConsentRequiredError('financial_text');
    });
    const service = new ConsentGatedAiUsageService('https://test.supabase.co', 'key', {
      require: requireConsent
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json([]))
    );
    await service.track(
      { ...params, operation: 'classify_forwarded_purchase' },
      async () => 'result',
      'forwarded_email'
    );
    expect(requireConsent).toHaveBeenCalledWith('owner-1', 'forwarded_email');
    vi.unstubAllGlobals();
  });
});
