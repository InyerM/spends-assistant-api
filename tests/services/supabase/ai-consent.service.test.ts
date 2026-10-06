import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_CONSENT_VERSION,
  AiConsentRequiredError,
  AiConsentService,
  AiConsentUnavailableError
} from '../../../src/services/supabase/ai-consent.service';

const service = new AiConsentService('https://test.supabase.co', 'service-key');
const userId = '11111111-1111-4111-8111-111111111111';

describe('AI consent', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('defaults to denied and never sends a prompt when no decision exists', async () => {
    const fetchMock = vi.fn(async () => Response.json([]));
    vi.stubGlobal('fetch', fetchMock);
    await expect(service.require(userId, 'financial_text')).rejects.toBeInstanceOf(
      AiConsentRequiredError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/rest/v1/ai_consent_decisions?');
  });

  it('accepts only an active decision at the current disclosure version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json([
          {
            scope: 'financial_text',
            version: 'external-ai-v0',
            granted_at: '2026-01-01',
            revoked_at: null
          },
          {
            scope: 'document_images',
            version: AI_CONSENT_VERSION,
            granted_at: '2026-01-01',
            revoked_at: null
          },
          {
            scope: 'forwarded_email',
            version: AI_CONSENT_VERSION,
            granted_at: '2026-01-01',
            revoked_at: '2026-02-01'
          }
        ])
      )
    );
    const state = await service.getState(userId);
    expect(state.consents).toEqual({
      financial_text: false,
      document_images: true,
      forwarded_email: false
    });
    await expect(service.require(userId, 'document_images')).resolves.toBeUndefined();
    await expect(service.require(userId, 'forwarded_email')).rejects.toBeInstanceOf(
      AiConsentRequiredError
    );
  });

  it('fails closed with a different error when storage is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'down' }, { status: 503 }))
    );
    await expect(service.require(userId, 'financial_text')).rejects.toBeInstanceOf(
      AiConsentUnavailableError
    );
  });

  it('persists an owner-scoped grant and revocation without prompt contents', async () => {
    const fetchMock = vi.fn(async () => Response.json([]));
    vi.stubGlobal('fetch', fetchMock);
    await service.setDecision(userId, 'forwarded_email', true, AI_CONSENT_VERSION);
    await service.setDecision(userId, 'forwarded_email', false, AI_CONSENT_VERSION);
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(bodies).toMatchObject([
      { user_id: userId, scope: 'forwarded_email', version: AI_CONSENT_VERSION, revoked_at: null },
      { user_id: userId, scope: 'forwarded_email', version: AI_CONSENT_VERSION }
    ]);
    expect(bodies[1].revoked_at).toBeTruthy();
    expect(JSON.stringify(bodies)).not.toMatch(/prompt|receipt|raw_text/iu);
  });
});
