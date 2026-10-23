import { beforeEach, expect, it, vi } from 'vitest';
import { processInboxAnalysisLease } from '../../src/services/inbox-analysis';
import { createMockEnv } from '../__test-helpers__/factories';
const mock = vi.hoisted(() => ({
  item: vi.fn(),
  consent: vi.fn(),
  reserve: vi.fn(),
  suggest: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  route: vi.fn(),
  history: vi.fn()
}));
vi.mock('../../src/services/supabase', () => ({
  createSupabaseServices: () => ({
    inboxAnalysis: { item: mock.item, complete: mock.complete, fail: mock.fail },
    aiConsent: { require: mock.consent },
    usage: { incrementAiParses: mock.reserve },
    aiUsage: {},
    categories: { getCategories: async () => [] },
    accounts: { getAccounts: async () => [] },
    categoryReviewContext: { history: mock.history },
    automationRules: {
      getAutomationRules: async () => [],
      findUniqueAccountDetectionRule: () => null
    },
    forwardingRoutes: { getForUser: mock.route }
  })
}));
vi.mock('../../src/ai/forwarded-email-suggestion', () => ({ suggestForwardedEmail: mock.suggest }));
const lease = { inbox_item_id: 'item', user_id: 'owner', lease_token: 'lease' };
beforeEach(() => {
  vi.clearAllMocks();
  mock.item.mockResolvedValue({
    id: 'item',
    user_id: 'owner',
    source: 'native-bank-message',
    status: 'pending',
    raw_text: 'Compra Spotify',
    received_at: '2026-10-02'
  });
  mock.consent.mockResolvedValue(undefined);
  mock.history.mockResolvedValue([]);
  mock.reserve.mockResolvedValue({ allowed: true, used: 1, limit: 15 });
  mock.suggest.mockResolvedValue({
    type: 'expense',
    categoryId: null,
    categorySource: null,
    description: 'Spotify',
    notes: null,
    amount: null,
    eventDate: null,
    bankEventAt: null,
    sourceLastFour: null
  });
  mock.complete.mockResolvedValue(true);
});
it('requires the source consent before reserving quota and performs no AI call on refusal', async () => {
  mock.consent.mockRejectedValue(new Error('unavailable'));
  await processInboxAnalysisLease(lease, createMockEnv());
  expect(mock.reserve).not.toHaveBeenCalled();
  expect(mock.suggest).not.toHaveBeenCalled();
  expect(mock.complete).not.toHaveBeenCalled();
});
it('blocks exhausted quota and does not call the model or financial posting', async () => {
  mock.reserve.mockResolvedValue({ allowed: false, used: 15, limit: 15 });
  await processInboxAnalysisLease(lease, createMockEnv());
  expect(mock.suggest).not.toHaveBeenCalled();
  expect(mock.fail).toHaveBeenCalledWith(lease, 'quota_limit', true);
});
it('persists only a proposal and uses financial-text consent for native captures', async () => {
  await processInboxAnalysisLease(lease, createMockEnv());
  expect(mock.consent).toHaveBeenCalledWith('owner', 'financial_text');
  expect(mock.suggest).toHaveBeenCalledWith(
    expect.any(String),
    [],
    expect.any(String),
    expect.any(String),
    'owner',
    expect.any(Object),
    expect.objectContaining({ consentScope: 'financial_text', allowWebSearch: false })
  );
  expect(mock.complete).toHaveBeenCalledWith(
    lease,
    expect.objectContaining({ description: 'Spotify' })
  );
});
it('blocks unverified forwarded email before exposing its text to AI', async () => {
  mock.item.mockResolvedValue({
    id: 'item',
    user_id: 'owner',
    source: 'forwarded_email',
    status: 'pending',
    raw_text: 'Private example'
  });
  mock.route.mockResolvedValue(null);
  await processInboxAnalysisLease(lease, createMockEnv());
  expect(mock.fail).toHaveBeenCalledWith(lease, 'unverified_source', true);
  expect(mock.suggest).not.toHaveBeenCalled();
});

it('uses the detected merchant to retrieve relevant history before considering email boilerplate', async () => {
  mock.item.mockResolvedValue({
    id: 'item',
    user_id: 'owner',
    source: 'native-bank-message',
    status: 'pending',
    raw_text:
      'Notificación del banco. Compraste $20.000 en SPOTIFY con tu T.Deb *2651 el 02/10/2026',
    received_at: '2026-10-02'
  });
  await processInboxAnalysisLease(lease, createMockEnv());
  expect(mock.history).toHaveBeenCalledWith('owner', 'SPOTIFY', 'expense');
});
