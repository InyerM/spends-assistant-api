import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAiConsent } from '../../src/handlers/ai-consent';
import { AI_CONSENT_VERSION } from '../../src/services/supabase/ai-consent.service';
import { createMockEnv } from '../__test-helpers__/factories';

const mocks = vi.hoisted(() => ({
  resolveUserId: vi.fn(),
  resolveSupabaseJwtUserId: vi.fn(),
  getState: vi.fn(),
  setDecision: vi.fn()
}));

vi.mock('../../src/utils/auth', () => ({
  resolveUserId: mocks.resolveUserId,
  resolveSupabaseJwtUserId: mocks.resolveSupabaseJwtUserId,
  unauthorizedResponse: () => Response.json({ error: 'Unauthorized' }, { status: 401 })
}));
vi.mock('../../src/services/supabase', () => ({
  createSupabaseServices: () => ({
    apiKeys: {},
    aiConsent: { getState: mocks.getState, setDecision: mocks.setDecision }
  })
}));

const state = {
  version: AI_CONSENT_VERSION,
  consents: { financial_text: false, document_images: false, forwarded_email: false }
};

function request(method: string, body?: unknown): Request {
  return new Request('http://localhost/ai/consent', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
}

describe('AI consent endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveUserId.mockResolvedValue('owner-1');
    mocks.resolveSupabaseJwtUserId.mockResolvedValue('owner-1');
    mocks.getState.mockResolvedValue(state);
    mocks.setDecision.mockResolvedValue(undefined);
  });

  it('does not disclose consent to an unauthenticated caller', async () => {
    mocks.resolveUserId.mockResolvedValue(null);
    const response = await handleAiConsent(request('GET'), createMockEnv());
    expect(response.status).toBe(401);
    expect(mocks.getState).not.toHaveBeenCalled();
  });

  it('returns the current owner state', async () => {
    const response = await handleAiConsent(request('GET'), createMockEnv());
    expect(await response.json()).toEqual(state);
    expect(mocks.getState).toHaveBeenCalledWith('owner-1');
  });

  it('requires a matching disclosure version before granting', async () => {
    const response = await handleAiConsent(
      request('POST', { scope: 'financial_text', granted: true, version: 'external-ai-v0' }),
      createMockEnv()
    );
    expect(response.status).toBe(409);
    expect(mocks.setDecision).not.toHaveBeenCalled();
  });

  it('rejects a key-authenticated POST even when read access resolves', async () => {
    mocks.resolveSupabaseJwtUserId.mockResolvedValue(null);
    const response = await handleAiConsent(
      request('POST', { scope: 'financial_text', granted: true, version: AI_CONSENT_VERSION }),
      createMockEnv()
    );
    expect(response.status).toBe(401);
    expect(mocks.setDecision).not.toHaveBeenCalled();
  });

  it('uses the verified JWT owner for a grant', async () => {
    mocks.resolveUserId.mockResolvedValue('key-owner');
    mocks.resolveSupabaseJwtUserId.mockResolvedValue('jwt-owner');
    const response = await handleAiConsent(
      request('POST', { scope: 'financial_text', granted: true, version: AI_CONSENT_VERSION }),
      createMockEnv()
    );
    expect(response.status).toBe(200);
    expect(mocks.setDecision).toHaveBeenCalledWith(
      'jwt-owner',
      'financial_text',
      true,
      AI_CONSENT_VERSION
    );
  });

  it('allows revocation and persists only the authenticated owner', async () => {
    const response = await handleAiConsent(
      request('POST', { scope: 'forwarded_email', granted: false, version: 'external-ai-v0' }),
      createMockEnv()
    );
    expect(response.status).toBe(200);
    expect(mocks.setDecision).toHaveBeenCalledWith(
      'owner-1',
      'forwarded_email',
      false,
      AI_CONSENT_VERSION
    );
  });
});
