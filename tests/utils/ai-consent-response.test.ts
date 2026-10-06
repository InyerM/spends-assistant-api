import { describe, expect, it } from 'vitest';
import { aiConsentErrorResponse } from '../../src/utils/ai-consent-response';
import {
  AI_CONSENT_VERSION,
  AiConsentRequiredError,
  AiConsentUnavailableError
} from '../../src/services/supabase/ai-consent.service';

describe('AI consent errors', () => {
  it('returns a distinct, prompt-free response for missing consent', async () => {
    const response = aiConsentErrorResponse(new AiConsentRequiredError('document_images'));
    expect(response?.status).toBe(428);
    expect(await response?.json()).toEqual({
      error: 'AI consent required',
      code: 'AI_CONSENT_REQUIRED',
      scope: 'document_images',
      version: AI_CONSENT_VERSION
    });
  });

  it('returns a temporary failure for unavailable consent storage', async () => {
    const response = aiConsentErrorResponse(new AiConsentUnavailableError());
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({
      error: 'AI consent unavailable',
      code: 'AI_CONSENT_UNAVAILABLE'
    });
  });

  it('leaves provider errors for their existing handler', () => {
    expect(aiConsentErrorResponse(new Error('provider failed'))).toBeNull();
  });
});
