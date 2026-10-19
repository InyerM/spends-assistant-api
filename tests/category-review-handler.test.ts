import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  review: vi.fn(),
  categories: vi.fn(),
  consent: vi.fn(),
  quota: vi.fn(),
  track: vi.fn()
}));
vi.mock('../src/utils/auth', () => ({
  resolveUserId: mocks.auth,
  unauthorizedResponse: () => new Response(null, { status: 401 })
}));
vi.mock('../src/ai/category-review', () => ({ reviewCategory: mocks.review }));
vi.mock('../src/services/supabase', () => ({
  createSupabaseServices: () => ({
    apiKeys: {},
    categories: { getCategories: mocks.categories },
    usage: { incrementAiParses: mocks.quota },
    aiUsage: { requireConsent: mocks.consent, track: mocks.track }
  })
}));
import { handleCategoryReview } from '../src/handlers/category-review';
import { createMockEnv } from './__test-helpers__/factories';
import { AiConsentRequiredError } from '../src/services/supabase/ai-consent.service';
const request = (body: unknown) =>
  new Request('https://worker/category/review', { method: 'POST', body: JSON.stringify(body) });
const input = { locale: 'es', type: 'expense', description: 'Lunch', history: [] };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue('owner');
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
