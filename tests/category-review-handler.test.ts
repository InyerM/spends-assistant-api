import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  review: vi.fn(),
  categories: vi.fn(),
  consent: vi.fn(),
  quota: vi.fn(),
  track: vi.fn(),
  history: vi.fn(),
  rules: vi.fn(),
  matches: vi.fn()
}));
vi.mock('../src/utils/auth', () => ({
  resolveUserId: mocks.auth,
  unauthorizedResponse: () => new Response(null, { status: 401 })
}));
vi.mock('../src/ai/category-review', () => ({ reviewCategory: mocks.review }));
vi.mock('../src/services/supabase', () => ({
  createSupabaseServices: () => ({
    apiKeys: {},
    categoryReviewContext: { history: mocks.history },
    automationRules: {
      getAutomationRules: mocks.rules,
      matchesConditions: mocks.matches
    },
    categories: { getCategories: mocks.categories },
    usage: { incrementAiParses: mocks.quota },
    aiUsage: { requireConsent: mocks.consent, track: mocks.track }
  })
}));
import { handleCategoryReview } from '../src/handlers/category-review';
import { createMockEnv } from './__test-helpers__/factories';
import { AiConsentRequiredError } from '../src/services/supabase/ai-consent.service';
import { OpenRouterError } from '../src/ai/openrouter';
const request = (body: unknown) =>
  new Request('https://worker/category/review', { method: 'POST', body: JSON.stringify(body) });
const input = { locale: 'es', type: 'expense', description: 'Lunch', history: [] };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue('owner');
  mocks.history.mockResolvedValue([]);
  mocks.rules.mockResolvedValue([]);
  mocks.matches.mockReturnValue(false);
  mocks.categories.mockResolvedValue([]);
  mocks.quota.mockResolvedValue({ allowed: true });
  mocks.consent.mockResolvedValue(undefined);
  mocks.review.mockResolvedValue({ explanation: 'Known notes', category_id: null });
  mocks.track.mockImplementation((_params, task) => task({}));
});
it('requires authentication and bounds context before contacting the provider', async () => {
  mocks.auth.mockResolvedValueOnce(null);
  expect((await handleCategoryReview(request(input), createMockEnv())).status).toBe(401);
  expect(
    (
      await handleCategoryReview(
        request({ ...input, history: Array(13).fill({}) }),
        createMockEnv()
      )
    ).status
  ).toBe(400);
  expect(mocks.review).not.toHaveBeenCalled();
});
it('checks consent and quota then tracks a read-only explanation', async () => {
  expect((await handleCategoryReview(request(input), createMockEnv())).status).toBe(200);
  expect(mocks.consent).toHaveBeenCalledWith('owner', 'financial_text');
  expect(mocks.categories).toHaveBeenCalledWith('owner');
  mocks.consent.mockRejectedValueOnce(new AiConsentRequiredError('financial_text'));
  expect((await handleCategoryReview(request(input), createMockEnv())).status).toBe(428);
  mocks.quota.mockResolvedValueOnce({ allowed: false });
  expect((await handleCategoryReview(request(input), createMockEnv())).status).toBe(429);
});
it('logs provider failure metadata without private financial context', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    mocks.review.mockRejectedValueOnce(new OpenRouterError(0, 'truncated', 'content'));
    const response = await handleCategoryReview(
      request({ ...input, description: 'Private merchant detail' }),
      createMockEnv()
    );
    expect(response.status).toBe(503);
    expect(log).toHaveBeenCalledWith('category_review_failed', {
      model: 'deepseek/deepseek-v4.1-flash',
      reason: 'truncated',
      stage: 'content',
      upstream_status: 0
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('Private merchant detail');
    expect(await response.json()).toEqual({ error: 'Category review unavailable' });
  } finally {
    log.mockRestore();
  }
});

it('supplies authoritative owner history and category rules to every review without trusting client history', async () => {
  const history = [{ id: 'owned', description: 'Previous purchase', category: 'Shopping' }];
  mocks.history.mockResolvedValueOnce(history);
  mocks.categories.mockResolvedValueOnce([{ id: 'shopping', type: 'expense' }]);
  mocks.rules.mockResolvedValueOnce([
    {
      name: 'My shopping rule',
      rule_type: 'general',
      conditions: { description_contains: ['Mercado'] },
      actions: { set_category: 'shopping' }
    }
  ]);
  mocks.matches.mockReturnValueOnce(true);
  await handleCategoryReview(
    request({
      ...input,
      description: 'Mercado Libre',
      history: [{ id: 'untrusted', description: 'Other', category: 'Other' }]
    }),
    createMockEnv()
  );
  expect(mocks.history).toHaveBeenCalledWith('owner', 'Mercado Libre', 'expense', undefined);
  expect(mocks.review).toHaveBeenCalledWith(
    expect.objectContaining({ history }),
    expect.any(Array),
    expect.any(String),
    expect.any(String),
    expect.any(Object),
    { preferences: [], categoryRule: { category_id: 'shopping', name: 'My shopping rule' } }
  );
});
