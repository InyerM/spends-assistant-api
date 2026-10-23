import { beforeEach, expect, it, vi } from 'vitest';
import { suggestForwardedEmail } from '../../src/ai/forwarded-email-suggestion';
import { createMockCategory } from '../__test-helpers__/factories';
const mocks = vi.hoisted(() => ({ complete: vi.fn(), web: vi.fn() }));
vi.mock('../../src/ai/openrouter', () => ({ completeJson: mocks.complete }));
vi.mock('../../src/ai/merchant-web-evidence', () => ({ findMerchantWebCategory: mocks.web }));
beforeEach(() => vi.clearAllMocks());

it('uses the financial-text consent scope for shortcuts and persists only supplied history evidence', async () => {
  mocks.complete.mockResolvedValue({
    data: {
      type: 'expense',
      category_slug: 'subscriptions',
      confidence: 0.95,
      description: 'Spotify Premium',
      notes: 'Plan familiar',
      explanation: 'Coincide con tu suscripción anterior.',
      evidence_ids: ['history-a', 'foreign-row']
    }
  });
  const track = vi.fn(async (_meta, run) => run({}));
  const result = await suggestForwardedEmail(
    'Pagué Spotify Premium, plan familiar',
    [createMockCategory({ user_id: 'owner', slug: 'subscriptions' })],
    'example',
    'model',
    'owner',
    { track } as never,
    {
      history: [{ id: 'history-a', description: 'Spotify Premium', category: 'Subscriptions' }],
      rules: [],
      consentScope: 'financial_text',
      allowWebSearch: false,
      includeExplanation: true
    }
  );
  expect(track).toHaveBeenCalledWith(expect.any(Object), expect.any(Function), 'financial_text');
  expect(result).toMatchObject({
    explanation: 'Coincide con tu suscripción anterior.',
    evidenceIds: ['history-a']
  });
  expect(mocks.web).not.toHaveBeenCalled();
});

it('keeps a confident purpose/history proposal ahead of the usual merchant fallback', async () => {
  mocks.complete.mockResolvedValue({
    data: {
      type: 'expense',
      category_slug: 'education',
      confidence: 0.97,
      description: 'Curso comprado en Amazon',
      notes: 'Curso para estudiar'
    }
  });
  const track = vi.fn(async (_meta, run) => run({}));
  const result = await suggestForwardedEmail(
    'Realizaste una compra en AMAZON.COM por $20,000 para un curso',
    [
      createMockCategory({ user_id: 'owner', slug: 'education', id: 'education' }),
      createMockCategory({ user_id: 'owner', slug: 'shopping', id: 'shopping' })
    ],
    'example',
    'model',
    'owner',
    { track } as never,
    { history: [], rules: [], allowWebSearch: false }
  );
  expect(result.categoryId).toBe('education');
});
