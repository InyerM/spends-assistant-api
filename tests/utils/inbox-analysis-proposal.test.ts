import { expect, it } from 'vitest';
import {
  buildDeterministicInboxAnalysisProposal,
  buildInboxAnalysisProposal
} from '../../src/utils/inbox-analysis-proposal';
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
  expect(result.analysis_details.financial_type).toBe('transfer');
  expect(result.analysis_details.transfer_to_account_id).toBe('destination');
  expect(result.analysis_details.applied_rules.map((row) => row.rule_id)).toEqual([
    'link',
    'destination'
  ]);
});

it('resolves an explicit event and owned rule category without model output', () => {
  const result = buildDeterministicInboxAnalysisProposal(
    { ...item, raw_text: item.raw_text + ' a las 14:30' },
    [createMockAccount({ id: 'account', user_id: owner })],
    [createMockCategory({ id: 'category', user_id: owner })],
    [
      createMockRule({
        user_id: owner,
        conditions: { raw_text_contains: ['Spotify'] },
        actions: { set_category: 'category' }
      })
    ],
    rulesService
  );
  expect(result).toMatchObject({
    status: 'parsed',
    amount: 20000,
    account_id: 'account',
    category_id: 'category',
    bank_event_at: '2026-10-02T14:30:00-05:00'
  });
  expect(result?.analysis_details.analysis_source).toBe('automation');
});

it.each([
  { label: 'missing timestamp', text: item.raw_text, account: '2651', categoryOwner: owner },
  {
    label: 'unresolved account',
    text: item.raw_text + ' a las 14:30',
    account: '9999',
    categoryOwner: owner
  },
  {
    label: 'foreign category',
    text: item.raw_text + ' a las 14:30',
    account: '2651',
    categoryOwner: 'other'
  },
  {
    label: 'conflicting amount',
    text: item.raw_text + ' a las 14:30 y pagaste $50.000',
    account: '2651',
    categoryOwner: owner
  }
])('leaves $label for the existing unresolved workflow', ({ text, account, categoryOwner }) => {
  expect(
    buildDeterministicInboxAnalysisProposal(
      { ...item, raw_text: text },
      [createMockAccount({ user_id: owner, last_four: account })],
      [createMockCategory({ id: 'category', user_id: categoryOwner })],
      [
        createMockRule({
          user_id: owner,
          conditions: { raw_text_contains: ['Spotify'] },
          actions: { set_category: 'category' }
        })
      ],
      rulesService
    )
  ).toBeNull();
});

it('keeps cross-currency transfers unresolved for exchange-rate review', () => {
  expect(
    buildDeterministicInboxAnalysisProposal(
      { ...item, raw_text: item.raw_text + ' a las 14:30' },
      [
        createMockAccount({ id: 'source', user_id: owner }),
        createMockAccount({ id: 'destination', user_id: owner, last_four: '9999', currency: 'USD' })
      ],
      [],
      [
        createMockRule({
          user_id: owner,
          conditions: { raw_text_contains: ['Spotify'] },
          actions: { link_to_account: 'destination' }
        })
      ],
      rulesService
    )
  ).toBeNull();
});

it.each([false, true])('keeps highest valid category write including null clear (%s)', (clear) => {
  const rules = [
    createMockRule({
      id: 'foreign',
      user_id: owner,
      priority: 200,
      conditions: {},
      actions: { set_category: 'foreign' }
    }),
    createMockRule({
      id: 'a',
      user_id: owner,
      priority: 100,
      conditions: {},
      actions: { set_category: clear ? null : 'high' }
    }),
    createMockRule({
      id: 'b',
      user_id: owner,
      priority: 10,
      conditions: {},
      actions: { set_category: 'low' }
    })
  ];
  const result = buildInboxAnalysisProposal(
    item,
    suggestion,
    [],
    ['high', 'low'].map((id) => createMockCategory({ id, user_id: owner })),
    rules,
    rulesService
  );
  expect(result.category_id).toBe(clear ? null : 'high');
});

it('does not let a lower transfer link erase a higher expense or category decision', () => {
  const accounts = [
    createMockAccount({ id: 'source', user_id: owner, last_four: '2651' }),
    createMockAccount({ id: 'dest', user_id: owner, last_four: '8888' })
  ];
  const rules = [
    createMockRule({
      id: 'high',
      user_id: owner,
      priority: 100,
      conditions: {},
      actions: { set_type: 'expense', set_category: 'high' }
    }),
    createMockRule({
      id: 'low',
      user_id: owner,
      priority: 10,
      conditions: {},
      actions: { link_to_account: 'dest' }
    })
  ];
  const result = buildInboxAnalysisProposal(
    item,
    suggestion,
    accounts,
    [createMockCategory({ id: 'high', user_id: owner })],
    rules,
    rulesService
  );
  expect(result.category_id).toBe('high');
  expect(result.analysis_details.financial_type).toBe('expense');
  expect(result.analysis_details.transfer_to_account_id).toBeNull();
});

it('resolves same-priority inbox category conflicts by ID rather than input order', () => {
  const rules = ['b', 'a'].map((id) =>
    createMockRule({
      id,
      user_id: owner,
      priority: 100,
      conditions: {},
      actions: { set_category: id }
    })
  );
  const result = buildInboxAnalysisProposal(
    item,
    suggestion,
    [],
    ['a', 'b'].map((id) => createMockCategory({ id, user_id: owner })),
    rules,
    rulesService
  );
  expect(result.category_id).toBe('a');
});

it('keeps first valid account/type/destination writes and continues notes after conflicts', () => {
  const accounts = ['source', 'chosen', 'destination', 'other'].map((id, i) =>
    createMockAccount({ id, user_id: owner, last_four: i === 0 ? '2651' : String(8000 + i) })
  );
  const rules = [
    createMockRule({
      id: 'invalid',
      user_id: owner,
      priority: 200,
      conditions: {},
      actions: { set_account: 'foreign' }
    }),
    createMockRule({
      id: 'high',
      user_id: owner,
      priority: 100,
      conditions: {},
      actions: { set_account: 'chosen', link_to_account: 'destination', add_note: 'First' }
    }),
    createMockRule({
      id: 'low',
      user_id: owner,
      priority: 10,
      conditions: { from_account: 'chosen', to_account: 'destination' },
      actions: {
        set_account: 'other',
        set_type: 'income',
        link_to_account: 'other',
        add_note: 'Second'
      }
    })
  ];
  const result = buildInboxAnalysisProposal(item, suggestion, accounts, [], rules, rulesService);
  expect(result.account_id).toBe('chosen');
  expect(result.analysis_details.financial_type).toBe('transfer');
  expect(result.analysis_details.transfer_to_account_id).toBe('destination');
  expect(result.notes).toBe('Plan familiar\nFirst\nSecond');
});

it('leaves a transfer without an owned distinct destination unresolved', () => {
  const result = buildInboxAnalysisProposal(
    item,
    suggestion,
    [createMockAccount({ id: 'source', user_id: owner, last_four: '2651' })],
    [],
    [
      createMockRule({
        user_id: owner,
        conditions: {},
        actions: { set_type: 'transfer', link_to_account: 'foreign' }
      })
    ],
    rulesService
  );
  expect(result.analysis_details.financial_type).toBeNull();
  expect(result.analysis_details.transfer_to_account_id).toBeNull();
  expect(result.status).toBe('needs_review');
});
