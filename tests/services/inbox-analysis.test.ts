import { beforeEach, expect, it, vi } from 'vitest';
import { processInboxAnalysisLease } from '../../src/services/inbox-analysis';
import {
  createMockAccount,
  createMockCategory,
  createMockAutomationRule,
  createMockEnv
} from '../__test-helpers__/factories';
import { AiConsentRequiredError } from '../../src/services/supabase/ai-consent.service';
import { AutomationRulesService } from '../../src/services/supabase/automation-rules.service';
const mock = vi.hoisted(() => ({
  item: vi.fn(),
  consent: vi.fn(),
  reserve: vi.fn(),
  suggest: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  route: vi.fn(),
  history: vi.fn(),
  exactHistory: vi.fn(),
  accounts: vi.fn(),
  categories: vi.fn(),
  rules: vi.fn()
}));
vi.mock('../../src/services/supabase', () => ({
  createSupabaseServices: () => ({
    inboxAnalysis: { item: mock.item, complete: mock.complete, fail: mock.fail },
    aiConsent: { require: mock.consent },
    usage: { incrementAiParses: mock.reserve },
    aiUsage: {},
    categories: { getCategories: mock.categories },
    accounts: { getAccounts: mock.accounts },
    categoryReviewContext: { history: mock.history, exactCategoryHistory: mock.exactHistory },
    automationRules: {
      getAutomationRules: mock.rules,
      findUniqueAccountDetectionRule: () => null,
      matchesConditions: (input: never, conditions: never, logic: never) =>
        new AutomationRulesService('https://example.test', 'example').matchesConditions(
          input,
          conditions,
          logic
        )
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
  mock.exactHistory.mockResolvedValue([]);
  mock.accounts.mockResolvedValue([]);
  mock.categories.mockResolvedValue([]);
  mock.rules.mockResolvedValue([]);
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
  expect(mock.reserve).toHaveBeenCalledExactlyOnceWith('owner');
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

it('completes a fully rule-resolved capture without AI consent, quota or a model request', async () => {
  mock.item.mockResolvedValue({
    id: 'item',
    user_id: 'owner',
    source: 'native-bank-message',
    status: 'pending',
    raw_text: 'Compraste $20.000 en SPOTIFY con tu T.Deb *2651 el 02/10/2026 a las 14:30',
    received_at: '2026-10-02'
  });
  mock.accounts.mockResolvedValue([createMockAccount({ user_id: 'owner' })]);
  mock.categories.mockResolvedValue([createMockCategory({ user_id: 'owner' })]);
  mock.rules.mockResolvedValue([
    createMockAutomationRule({
      user_id: 'owner',
      conditions: { raw_text_contains: ['SPOTIFY'] },
      actions: { set_category: 'cat-1' }
    })
  ]);
  await processInboxAnalysisLease(lease, createMockEnv());
  expect(mock.complete).toHaveBeenCalledWith(
    lease,
    expect.objectContaining({ amount: 20000, category_id: 'cat-1', account_id: 'acc-1' })
  );
  expect(mock.consent).not.toHaveBeenCalled();
  expect(mock.reserve).not.toHaveBeenCalled();
  expect(mock.suggest).not.toHaveBeenCalled();
  expect(mock.fail).not.toHaveBeenCalled();
  expect(mock.history).not.toHaveBeenCalled();
});

it('keeps incomplete captures blocked when AI consent is missing', async () => {
  mock.consent.mockRejectedValue(new AiConsentRequiredError('financial_text'));
  await processInboxAnalysisLease(lease, createMockEnv());
  expect(mock.fail).toHaveBeenCalledWith(lease, 'consent_required', true);
  expect(mock.suggest).not.toHaveBeenCalled();
  expect(mock.reserve).not.toHaveBeenCalled();
  expect(mock.complete).not.toHaveBeenCalled();
  expect(mock.history).not.toHaveBeenCalled();
});

it('uses unanimous exact owned history before consent for a complete explicit capture', async () => {
  mock.item.mockResolvedValue({
    id: 'item',
    user_id: 'owner',
    source: 'native-bank-message',
    status: 'pending',
    raw_text: 'Compraste $20.000 en SPOTIFY con tu T.Deb *2651 el 02/10/2026 a las 14:30',
    received_at: '2026-10-02'
  });
  mock.accounts.mockResolvedValue([createMockAccount({ user_id: 'owner' })]);
  mock.categories.mockResolvedValue([createMockCategory({ user_id: 'owner' })]);
  mock.exactHistory.mockResolvedValue(
    ['one', 'two'].map((id) => ({
      id,
      user_id: 'owner',
      description: 'SPOTIFY',
      type: 'expense',
      date: '2026-10-01',
      category_id: 'cat-1'
    }))
  );
  await processInboxAnalysisLease(lease, createMockEnv());
  expect(mock.complete).toHaveBeenCalledWith(
    lease,
    expect.objectContaining({
      category_id: 'cat-1',
      category_source: 'review_context',
      analysis_details: expect.objectContaining({
        history_fields: ['categoryId'],
        evidence_ids: ['one', 'two']
      })
    })
  );
  expect(mock.consent).not.toHaveBeenCalled();
  expect(mock.suggest).not.toHaveBeenCalled();
});
