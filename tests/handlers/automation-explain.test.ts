import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAutomationExplain } from '../../src/handlers/automation-explain';
import { createMockEnv } from '../__test-helpers__/factories';
const rule = {
  name: 'Coffee',
  rule_type: 'general',
  condition_logic: 'and',
  conditions: { raw_text_contains: ['coffee'] },
  actions: { add_note: 'Reviewed' }
};
const cache = new Map<string, string>();
const mocks = vi.hoisted(() => ({
  track: vi.fn(),
  complete: vi.fn(),
  get: vi.fn(),
  save: vi.fn()
}));
vi.mock('../../src/services/supabase', () => ({
  createSupabaseServices: () => ({
    apiKeys: {},
    accounts: { getAccounts: async () => [] },
    categories: { getCategories: async () => [] },
    automationRules: { getExplanation: mocks.get, saveExplanation: mocks.save },
    aiUsage: { track: mocks.track }
  })
}));
vi.mock('../../src/utils/auth', () => ({
  resolveUserId: async (request: Request) =>
    request.headers.get('Authorization') ? 'owner' : null,
  unauthorizedResponse: () => Response.json({ error: 'Unauthorized' }, { status: 401 })
}));
vi.mock('../../src/ai/openrouter', () => ({ completeJson: mocks.complete }));
function request(body: unknown = { rule, locale: 'es' }, auth = true): Request {
  return new Request('http://localhost/automation/explain', {
    method: 'POST',
    headers: auth ? { Authorization: 'Bearer owner' } : {},
    body: JSON.stringify(body)
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  cache.clear();
  mocks.get.mockImplementation(
    async (_user, fingerprint, locale) => cache.get(fingerprint + locale) ?? null
  );
  mocks.save.mockImplementation(async (_user, fingerprint, locale, explanation) => {
    cache.set(fingerprint + locale, explanation);
  });
  mocks.track.mockImplementation(async (_params, callback) => callback({}));
  mocks.complete.mockResolvedValue({
    data: { explanation: 'When coffee appears, adds Reviewed to the notes.' }
  });
});
describe('automation explanation cache', () => {
  it('authenticates before context reads and rejects malformed drafts', async () => {
    expect((await handleAutomationExplain(request(undefined, false), createMockEnv())).status).toBe(
      401
    );
    expect((await handleAutomationExplain(request({ rule: null }), createMockEnv())).status).toBe(
      400
    );
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it('persists and reuses the owner-scoped explanation without spending AI again', async () => {
    const first = await handleAutomationExplain(request(), createMockEnv());
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ cached: false, explanation: expect.any(String) });
    const second = await handleAutomationExplain(request(), createMockEnv());
    expect(await second.json()).toMatchObject({ cached: true });
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith('owner', expect.any(String), 'es');
  });
  it('refreshes only changed behavior or language and explains actual engine limits', async () => {
    await handleAutomationExplain(request(), createMockEnv());
    await handleAutomationExplain(
      request({ rule: { ...rule, priority: 5 }, locale: 'es' }),
      createMockEnv()
    );
    await handleAutomationExplain(request({ rule, locale: 'en' }), createMockEnv());
    expect(mocks.complete).toHaveBeenCalledTimes(3);
    expect(mocks.complete.mock.calls[0][0].system).toContain(
      'All different condition fields must match'
    );
    expect(mocks.complete.mock.calls[0][0].system).toContain('auto_reconcile');
  });
  it('returns consent errors without caching or preventing rule saves', async () => {
    const { AiConsentRequiredError } = await import(
      '../../src/services/supabase/ai-consent.service'
    );
    mocks.track.mockRejectedValueOnce(new AiConsentRequiredError('financial_text'));
    const response = await handleAutomationExplain(request(), createMockEnv());
    expect(response.status).toBe(428);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

describe('safe automation explanation diagnostics', () => {
  it('rejects null/non-object model output with an allowlisted validation reason', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const data of [null, 'unexpected', []]) {
      mocks.complete.mockResolvedValueOnce({ data });
      const response = await handleAutomationExplain(request(), createMockEnv());
      expect(await response.json()).toMatchObject({
        stage: 'validation',
        reason: 'INVALID_EXPLANATION'
      });
    }
    expect(mocks.save).not.toHaveBeenCalled();
    log.mockRestore();
  });
  it('identifies cache-read failures without exposing database details or owner data', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.get.mockRejectedValueOnce(new Error('API Error: private table SQL owner-token'));
    const response = await handleAutomationExplain(request(), createMockEnv());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'AUTOMATION_EXPLANATION_UNAVAILABLE',
      stage: 'cache_read'
    });
    expect(log).toHaveBeenCalledWith('[Automation explanation] Failed', {
      stage: 'cache_read',
      code: 'UNAVAILABLE'
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('owner-token');
    expect(mocks.complete).not.toHaveBeenCalled();
    log.mockRestore();
  });
  it('distinguishes provider/schema failure from a cache-write failure', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.complete.mockRejectedValueOnce(new Error('OpenRouter request failed (404)'));
    const provider = await handleAutomationExplain(request(), createMockEnv());
    expect(await provider.json()).toMatchObject({ stage: 'generation', reason: 'PROVIDER_404' });
    expect(log).toHaveBeenCalledWith('[Automation explanation] Failed', {
      stage: 'generation',
      code: 'PROVIDER_404'
    });
    mocks.complete.mockResolvedValueOnce({ data: { explanation: 'Private explanation' } });
    mocks.save.mockRejectedValueOnce(new Error('Private SQL details'));
    const storage = await handleAutomationExplain(request(), createMockEnv());
    expect(await storage.json()).toMatchObject({ stage: 'cache_write' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('Private');
    log.mockRestore();
  });
});
