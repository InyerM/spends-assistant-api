import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockCategory, createMockEnv } from '../__test-helpers__/factories';
import { handleForwardedEmailSuggest } from '../../src/handlers/forwarded-email-suggest';
import { OpenRouterError } from '../../src/ai/openrouter';
import { AiConsentRequiredError } from '../../src/services/supabase/ai-consent.service';

const mocks = vi.hoisted(() => ({
  resolveUserId: vi.fn(),
  getCategories: vi.fn(),
  suggest: vi.fn()
}));
vi.mock('../../src/utils/auth', () => ({
  resolveUserId: mocks.resolveUserId,
  unauthorizedResponse: () => Response.json({ error: 'Unauthorized' }, { status: 401 })
}));
vi.mock('../../src/services/supabase', () => ({
  createSupabaseServices: () => ({
    apiKeys: {},
    categories: { getCategories: mocks.getCategories },
    aiUsage: {}
  })
}));
vi.mock('../../src/ai/forwarded-email-suggestion', () => ({
  suggestForwardedEmail: mocks.suggest
}));

const request = (message: unknown): Request =>
  new Request('http://localhost/forwarded-email/suggest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });

describe('forwarded email suggestion endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveUserId.mockResolvedValue('owner');
    mocks.getCategories.mockResolvedValue([
      createMockCategory({ id: 'education-id', slug: 'education', user_id: 'owner' })
    ]);
    mocks.suggest.mockResolvedValue({
      type: 'expense',
      categoryId: 'education-id',
      categorySource: 'catalog',
      description: 'Course at CEA Practicar del Eje',
      notes: 'Card ending 8456.'
    });
  });

  it('returns owner-scoped suggestions without financial posting', async () => {
    const response = await handleForwardedEmailSuggest(
      request('Purchased a course at CEA Practicar del Eje'),
      createMockEnv()
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      type: 'expense',
      category_id: 'education-id',
      category_source: 'catalog',
      description: 'Course at CEA Practicar del Eje',
      notes: 'Card ending 8456.',
      bank_event_at: null,
      amount: null,
      event_date: null,
      source_last_four: null
    });
    expect(mocks.suggest).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      'test-openrouter-key',
      'deepseek/deepseek-v4.1-flash',
      'owner',
      expect.any(Object)
    );
  });

  it('exposes validated event time to web and native clients', async () => {
    mocks.suggest.mockResolvedValueOnce({
      type: 'expense',
      categoryId: null,
      categorySource: null,
      description: null,
      notes: null,
      bankEventAt: '2026-10-02T16:31:00-05:00'
    });
    const response = await handleForwardedEmailSuggest(
      request('Pago QR de $15,800 el 02/10/2026 a las 16:31.'),
      createMockEnv()
    );
    expect(await response.json()).toMatchObject({ bank_event_at: '2026-10-02T16:31:00-05:00' });
  });

  it('requires authentication and bounded email text', async () => {
    mocks.resolveUserId.mockResolvedValueOnce(null);
    expect(
      (await handleForwardedEmailSuggest(request('Valid email text'), createMockEnv())).status
    ).toBe(401);
    for (const message of ['', 4, 'x'.repeat(12001)]) {
      expect((await handleForwardedEmailSuggest(request(message), createMockEnv())).status).toBe(
        400
      );
    }
    expect(mocks.suggest).not.toHaveBeenCalled();
  });

  it('logs only safe failure classification and returns a generic error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.suggest.mockRejectedValueOnce(new OpenRouterError(503, 'http'));
    const response = await handleForwardedEmailSuggest(
      request('Private synthetic financial content'),
      createMockEnv()
    );
    expect(response.status).toBe(503);
    expect(log).toHaveBeenCalledWith('forwarded_email_suggestion_failed', {
      operation: 'triage_forwarded_email',
      model: 'deepseek/deepseek-v4.1-flash',
      reason: 'http',
      upstream_status: 503
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('Private');
    expect(await response.json()).toEqual({ error: 'Email suggestion unavailable' });
    log.mockRestore();
  });

  it('preserves the forwarded-email consent requirement', async () => {
    mocks.suggest.mockRejectedValueOnce(new AiConsentRequiredError('forwarded_email'));
    const response = await handleForwardedEmailSuggest(
      request('Purchased a driving course'),
      createMockEnv()
    );
    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({ scope: 'forwarded_email' });
  });

  it('distinguishes malformed response stages without logging financial content', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.suggest.mockRejectedValueOnce(new OpenRouterError(0, 'invalid_json', 'envelope'));
    const response = await handleForwardedEmailSuggest(
      request('Private synthetic financial content'),
      createMockEnv()
    );
    expect(response.status).toBe(503);
    expect(log).toHaveBeenCalledWith(
      'forwarded_email_suggestion_failed',
      expect.objectContaining({ reason: 'invalid_json', stage: 'envelope' })
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('Private');
    log.mockRestore();
  });
});
