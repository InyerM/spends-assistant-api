import { expect, it } from 'vitest';
import { buildInboxAnalysisProposal } from '../../src/utils/inbox-analysis-proposal';
import { AutomationRulesService } from '../../src/services/supabase/automation-rules.service';
import {
  createMockAccount,
  createMockCategory,
  createMockAutomationRule as createMockRule
} from '../__test-helpers__/factories';
const owner = 'owner';
const item = {
  id: 'item',
  user_id: owner,
  source: 'native-bank-message',
  status: 'pending',
  raw_text: 'Compraste $20.000 en Spotify con tu T.Deb *2651 el 02/10/2026',
  received_at: '2026-10-02T12:00:00Z'
};
const suggestion = {
  type: 'expense' as const,
  categoryId: 'ai-category',
  categorySource: 'ai' as const,
  description: 'Spotify Premium',
  notes: 'Plan familiar',
  bankEventAt: null,
  amount: '20000.00',
  eventDate: '2026-10-02',
  sourceLastFour: '2651',
  evidenceIds: ['owned-history'],
  explanation: 'Suscripción mensual.'
};
const rulesService = new AutomationRulesService('https://example.test', 'example');

it('applies a rule chain to the evolving account and retains useful AI wording and notes', () => {
  const accounts = [
    createMockAccount({ id: 'account', user_id: owner }),
    createMockAccount({ id: 'second', user_id: owner, last_four: '9988' })
  ];
  const categories = [
    createMockCategory({ id: 'ai-category', user_id: owner }),
    createMockCategory({ id: 'rule-category', user_id: owner })
  ];
  const rules = [
    createMockRule({
      user_id: owner,
      priority: 100,
      conditions: { raw_text_contains: ['Spotify'] },
      actions: { set_account: 'second' }
    }),
    createMockRule({
      id: 'rule-b',
      user_id: owner,
      priority: 50,
      conditions: { from_account: 'second' },
      actions: { set_category: 'rule-category', add_note: 'Trabajo' }
    })
  ];
  const proposal = buildInboxAnalysisProposal(
    item,
    suggestion,
    accounts,
    categories,
    rules,
    rulesService
  );
  expect(proposal).toMatchObject({
    category_id: 'rule-category',
    category_source: 'automation',
    account_id: 'second',
    description: 'Spotify Premium',
    notes: 'Plan familiar\nTrabajo',
    status: 'needs_review'
  });
  expect(proposal.analysis_details.applied_rules).toHaveLength(2);
});

it('does not accept foreign account/category actions or invent ownership from ambiguous suffixes', () => {
  const accounts = [
    createMockAccount({ id: 'a', user_id: owner }),
    createMockAccount({ id: 'b', user_id: owner }),
    createMockAccount({ id: 'foreign-account', user_id: 'other' })
  ];
  const rules = [
    createMockRule({
      user_id: owner,
      conditions: {},
      actions: { set_account: 'foreign-account', set_category: 'foreign-category' }
    })
  ];
  const result = buildInboxAnalysisProposal(
    item,
    suggestion,
    accounts,
    [createMockCategory({ id: 'foreign-category', user_id: 'other' })],
    rules,
    rulesService
  );
  expect(result.account_id).toBeNull();
  expect(result.category_id).toBeNull();
  expect(result.category_source).toBeNull();
});

it('marks an explicitly linked own transfer as nonposting metadata with no spending category', () => {
  const rules = [
    createMockRule({ user_id: owner, conditions: {}, actions: { link_to_account: 'destination' } })
  ];
  const result = buildInboxAnalysisProposal(
    item,
    suggestion,
    [
      createMockAccount({ user_id: owner }),
      createMockAccount({ id: 'destination', user_id: owner, last_four: '8888' })
    ],
    [createMockCategory({ id: 'ai-category', user_id: owner })],
    rules,
    rulesService
  );
  expect(result.category_id).toBeNull();
  expect(result.suggested_type).toBeNull();
  expect(result.analysis_details).toMatchObject({
    financial_type: 'transfer',
    transfer_to_account_id: 'destination'
  });
});

it('evaluates category and destination conditions against each evolving suggestion', () => {
  const categories = [
    createMockCategory({ id: 'ai-category', user_id: owner }),
    createMockCategory({ id: 'other', user_id: owner })
  ];
  const accounts = [
    createMockAccount({ id: 'account', user_id: owner, last_four: '2651' }),
    createMockAccount({ id: 'destination', user_id: owner, last_four: '8888' })
  ];
  const rules = [
    createMockRule({
      id: 'wrong-category',
      user_id: owner,
      priority: 100,
      conditions: { category: 'other' },
      actions: { add_note: 'Wrong' }
    }),
    createMockRule({
      id: 'link',
      user_id: owner,
      priority: 90,
      conditions: { category: 'ai-category' },
      actions: { link_to_account: 'destination' }
    }),
    createMockRule({
      id: 'destination',
      user_id: owner,
      priority: 80,
      conditions: { to_account: 'destination' },
      actions: { add_note: 'Own payment' }
    }),
    createMockRule({
      id: 'reclassify',
      user_id: owner,
      priority: 70,
      conditions: { to_account: 'destination' },
      actions: { set_type: 'income' }
    })
  ];
  const result = buildInboxAnalysisProposal(
    item,
    suggestion,
    accounts,
    categories,
    rules,
    rulesService
  );
  expect(result.notes).toBe('Plan familiar\nOwn payment');
  expect(result.analysis_details.financial_type).toBe('income');
  expect(result.analysis_details.transfer_to_account_id).toBeNull();
  expect(result.analysis_details.applied_rules.map((row) => row.rule_id)).toEqual([
    'link',
    'destination',
    'reclassify'
  ]);
});
