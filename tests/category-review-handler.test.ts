import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  review: vi.fn(),
  categories: vi.fn(),
  consent: vi.fn(),
  quota: vi.fn(),
  track: vi.fn(),
  history: vi.fn(),
  evidence: vi.fn(),
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
    accounts: { getAccounts: vi.fn().mockResolvedValue([]) },
    categoryReviewContext: { reviewHistory: mocks.history, evidenceReview: mocks.evidence },
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
  mocks.evidence.mockResolvedValue(null);
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
  expect(mocks.history).toHaveBeenCalledWith(
    'owner',
    'Mercado Libre',
    'expense',
    undefined,
    undefined
  );
  expect(mocks.review).toHaveBeenCalledWith(
    expect.objectContaining({ history }),
    expect.any(Array),
    expect.any(String),
    expect.any(String),
    expect.any(Object),
    expect.objectContaining({
      preferences: [],
      categoryRule: { category_id: 'shopping', name: 'My shopping rule' }
    })
  );
});

it('rejects a foreign review identity before quota or model inference', async () => {
  const { ReviewTransactionNotFoundError } = await import(
    '../src/services/supabase/category-review-context.service'
  );
  mocks.history.mockRejectedValueOnce(new ReviewTransactionNotFoundError());
  const response = await handleCategoryReview(
    request({
      ...input,
      transaction_id: '00000000-0000-4000-8000-000000000099',
      history: [{ id: 'forged', description: 'Fake', category: 'Fake' }]
    }),
    createMockEnv()
  );
  expect(response.status).toBe(404);
  expect(mocks.quota).not.toHaveBeenCalled();
  expect(mocks.review).not.toHaveBeenCalled();
});

it('uses the verified transaction identity for lookup while retaining editable description and notes', async () => {
  const transactionId = '00000000-0000-4000-8000-000000000001';
  const history = [
    { id: 'contact-owned', description: 'School support', notes: 'Tuition', category: 'Education' }
  ];
  mocks.history.mockResolvedValueOnce(history);
  await handleCategoryReview(
    request({
      ...input,
      transaction_id: transactionId,
      description: 'Edited merchant',
      notes: 'Explicit current purpose',
      history: [{ id: 'forged', description: 'Forged', category: 'Wrong' }]
    }),
    createMockEnv()
  );
  expect(mocks.history).toHaveBeenCalledWith(
    'owner',
    'Edited merchant',
    'expense',
    transactionId,
    'Explicit current purpose'
  );
  expect(mocks.review).toHaveBeenCalledWith(
    expect.objectContaining({
      transaction_id: transactionId,
      description: 'Edited merchant',
      notes: 'Explicit current purpose',
      history
    }),
    expect.any(Array),
    expect.any(String),
    expect.any(String),
    expect.any(Object),
    expect.any(Object)
  );
});

it('proposes Barbería from exact destination history before consent, quota or AI without changing source text', async () => {
  const original = 'Transferencia de $30,000.00 desde cuenta *2651 a la cuenta *3243466403';
  mocks.evidence.mockResolvedValueOnce({ categoryId: 'barber', evidenceIds: ['one', 'two'] });
  mocks.categories.mockResolvedValueOnce([
    { id: 'barber', name: 'Barbería', translations: { es: 'Barbería' } }
  ]);
  const response = await handleCategoryReview(
    request({
      ...input,
      description: original,
      excerpt: original,
      event_date: '2026-11-12',
      review_fields: ['category']
    }),
    createMockEnv()
  );
  expect(await response.json()).toMatchObject({
    category_id: 'barber',
    description: original,
    notes: '',
    kind: 'expense',
    evidence_ids: ['one', 'two'],
    source: 'history'
  });
  expect(mocks.consent).not.toHaveBeenCalled();
  expect(mocks.quota).not.toHaveBeenCalled();
  expect(mocks.review).not.toHaveBeenCalled();
});

it('keeps explicit category clearing ahead of history and never asks AI to undo it', async () => {
  mocks.rules.mockResolvedValueOnce([
    { name: 'Clear', conditions: {}, actions: { set_category: null } }
  ]);
  mocks.matches.mockReturnValueOnce(true);
  const response = await handleCategoryReview(
    request({ ...input, event_date: '2026-11-12', review_fields: ['category'] }),
    createMockEnv()
  );
  expect(await response.json()).toMatchObject({ category_id: null, source: 'automation' });
  expect(mocks.evidence).not.toHaveBeenCalled();
  expect(mocks.review).not.toHaveBeenCalled();
});

it('keeps full review wording and notes available while protecting the deterministic category', async () => {
  mocks.evidence.mockResolvedValueOnce({
    categoryId: 'barber',
    evidenceIds: ['one', 'two'],
    history: [{ id: 'one', description: 'Previous haircut', category: 'Barbería' }]
  });
  mocks.categories.mockResolvedValueOnce([{ id: 'barber', name: 'Barbería' }]);
  mocks.review.mockResolvedValueOnce({
    category_id: null,
    description: 'Reviewed wording',
    notes: 'Reviewed note',
    kind: 'unknown',
    evidence_ids: []
  });
  const response = await handleCategoryReview(
    request({ ...input, event_date: '2026-11-12' }),
    createMockEnv()
  );
  expect(await response.json()).toMatchObject({
    category_id: 'barber',
    description: 'Reviewed wording',
    notes: 'Reviewed note',
    kind: 'expense',
    source: 'mixed'
  });
  expect(mocks.consent).toHaveBeenCalledOnce();
  expect(mocks.review).toHaveBeenCalledWith(
    expect.objectContaining({ history: [expect.objectContaining({ id: 'one' })] }),
    expect.any(Array),
    expect.any(String),
    expect.any(String),
    expect.any(Object),
    expect.any(Object)
  );
});

it('keeps explicit category clearing authoritative without a date', async () => {
  mocks.rules.mockResolvedValueOnce([
    { name: 'Clear', conditions: {}, actions: { set_category: null } }
  ]);
  mocks.matches.mockReturnValueOnce(true);
  const response = await handleCategoryReview(
    request({ ...input, review_fields: ['category'] }),
    createMockEnv()
  );
  expect(await response.json()).toMatchObject({ category_id: null, source: 'automation' });
  expect(mocks.review).not.toHaveBeenCalled();
});

it('resolves category and the exact contact label for a statement without reserving AI', async () => {
  const original = 'Transferencia de $30,000.00 desde cuenta *2651 a la cuenta *3243466403';
  mocks.evidence.mockResolvedValueOnce({
    categoryId: 'barber',
    evidenceIds: ['one', 'two'],
    description: 'Transferencia a Mi barbería',
    recognized_contact: { id: 'destination', label: 'Mi barbería' },
    history: []
  });
  mocks.categories.mockResolvedValueOnce([{ id: 'barber', name: 'Barbería' }]);
  const response = await handleCategoryReview(
    request({
      ...input,
      description: original,
      excerpt: original,
      event_date: '2026-11-12',
      review_fields: ['category', 'description']
    }),
    createMockEnv()
  );
  expect(await response.json()).toMatchObject({
    category_id: 'barber',
    description: 'Transferencia a Mi barbería',
    original_description: original,
    recognized_contact: { id: 'destination', label: 'Mi barbería' },
    field_sources: { category: 'history', description: 'contact', notes: 'original' },
    source: 'history'
  });
  expect(mocks.consent).not.toHaveBeenCalled();
  expect(mocks.quota).not.toHaveBeenCalled();
  expect(mocks.review).not.toHaveBeenCalled();
});

it('requires consent for unresolved wording even when category history is already known', async () => {
  mocks.evidence.mockResolvedValueOnce({
    categoryId: 'barber',
    evidenceIds: ['one', 'two'],
    history: []
  });
  mocks.consent.mockRejectedValueOnce(new AiConsentRequiredError('financial_text'));
  const response = await handleCategoryReview(
    request({ ...input, event_date: '2026-11-12', review_fields: ['category', 'description'] }),
    createMockEnv()
  );
  expect(response.status).toBe(428);
  expect(mocks.quota).not.toHaveBeenCalled();
  expect(mocks.review).not.toHaveBeenCalled();
});

it('resolves verified contact wording independently while a category rule remains authoritative', async () => {
  mocks.rules.mockResolvedValueOnce([
    { name: 'My rule', conditions: {}, actions: { set_category: 'rule-category' } }
  ]);
  mocks.matches.mockReturnValueOnce(true);
  mocks.categories.mockResolvedValueOnce([{ id: 'rule-category', type: 'expense' }]);
  mocks.evidence.mockResolvedValueOnce({
    categoryId: 'barber',
    evidenceIds: ['old'],
    history: [],
    description: 'Transferencia a Mi barbería',
    recognized_contact: { id: 'contact', label: 'Mi barbería' }
  });
  const response = await handleCategoryReview(
    request({ ...input, event_date: '2026-11-12', review_fields: ['category', 'description'] }),
    createMockEnv()
  );
  expect(await response.json()).toMatchObject({
    category_id: 'rule-category',
    description: 'Transferencia a Mi barbería',
    source: 'automation'
  });
  expect(mocks.review).not.toHaveBeenCalled();
  expect(mocks.quota).not.toHaveBeenCalled();
});

it('reports mixed provenance when AI supplies category and code supplies only the contact description', async () => {
  mocks.evidence.mockResolvedValueOnce({
    categoryId: null,
    evidenceIds: [],
    history: [],
    description: 'Transferencia a Mi barbería',
    recognized_contact: { id: 'contact', label: 'Mi barbería' }
  });
  mocks.review.mockResolvedValueOnce({
    category_id: 'other',
    description: 'Model wording',
    notes: 'Unrequested note',
    kind: 'expense',
    evidence_ids: []
  });
  const response = await handleCategoryReview(
    request({ ...input, event_date: '2026-11-12', review_fields: ['category', 'description'] }),
    createMockEnv()
  );
  expect(await response.json()).toMatchObject({
    source: 'mixed',
    category_id: 'other',
    description: 'Transferencia a Mi barbería',
    notes: '',
    field_sources: { category: 'ai', description: 'contact', notes: 'original' }
  });
});

it('preserves original wording for an explicit category-only review even with a verified alias', async () => {
  mocks.evidence.mockResolvedValueOnce({
    categoryId: 'barber',
    evidenceIds: ['old'],
    history: [],
    description: 'Transferencia a Mi barbería'
  });
  const response = await handleCategoryReview(
    request({ ...input, event_date: '2026-11-12', review_fields: ['category'] }),
    createMockEnv()
  );
  expect(await response.json()).toMatchObject({ description: 'Lunch', category_id: 'barber' });
});

it('preserves category and description for a notes-only request', async () => {
  mocks.evidence.mockResolvedValueOnce({
    categoryId: 'barber',
    evidenceIds: ['old'],
    history: [],
    description: 'Transferencia a Mi barbería'
  });
  mocks.review.mockResolvedValueOnce({
    category_id: 'model-category',
    description: 'Model wording',
    notes: 'Reviewed note',
    kind: 'unknown',
    evidence_ids: []
  });
  const response = await handleCategoryReview(
    request({
      ...input,
      category_id: 'original-category',
      event_date: '2026-11-12',
      review_fields: ['notes']
    }),
    createMockEnv()
  );
  expect(await response.json()).toMatchObject({
    category_id: 'original-category',
    description: 'Lunch',
    notes: 'Reviewed note',
    kind: 'expense',
    field_sources: { category: 'original', description: 'original', notes: 'ai' }
  });
});

it('keeps requested AI wording when a recognized contact has no safe outgoing description', async () => {
  mocks.evidence.mockResolvedValueOnce({
    categoryId: 'barber',
    evidenceIds: ['old'],
    history: [],
    recognized_contact: { id: 'contact', label: 'Contact' }
  });
  mocks.review.mockResolvedValueOnce({
    category_id: null,
    description: 'Requested reviewed wording',
    notes: '',
    kind: 'unknown',
    evidence_ids: []
  });
  const response = await handleCategoryReview(
    request({ ...input, event_date: '2026-11-12', review_fields: ['category', 'description'] }),
    createMockEnv()
  );
  expect(await response.json()).toMatchObject({
    category_id: 'barber',
    description: 'Requested reviewed wording',
    source: 'mixed',
    field_sources: { category: 'history', description: 'ai', notes: 'original' }
  });
});

it('does not call AI when the only requested description is resolved by the exact contact', async () => {
  mocks.evidence.mockResolvedValueOnce({
    categoryId: null,
    evidenceIds: [],
    history: [],
    description: 'Transferencia a Mi barbería',
    recognized_contact: { id: 'contact', label: 'Mi barbería' }
  });
  const response = await handleCategoryReview(
    request({
      ...input,
      category_id: 'original-category',
      event_date: '2026-11-12',
      review_fields: ['description']
    }),
    createMockEnv()
  );
  expect(await response.json()).toMatchObject({
    category_id: 'original-category',
    description: 'Transferencia a Mi barbería',
    source: 'evidence',
    field_sources: { category: 'original', description: 'contact', notes: 'original' }
  });
  expect(mocks.review).not.toHaveBeenCalled();
  expect(mocks.quota).not.toHaveBeenCalled();
});
