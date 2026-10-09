import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutomationRulesService } from '../../../src/services/supabase/automation-rules.service';
import {
  createMockAutomationRule,
  createMockTransactionInput,
  createMockFetch
} from '../../__test-helpers__/factories';

const URL = 'https://test.supabase.co';
const KEY = 'test-key';

describe('AutomationRulesService', () => {
  let service: AutomationRulesService;

  beforeEach(() => {
    service = new AutomationRulesService(URL, KEY);
    vi.restoreAllMocks();
  });

  it('generates detection rules for each active ending and omits retired cards', () => {
    const account = {
      id: 'account-1',
      user_id: 'owner',
      name: 'Bancolombia savings',
      type: 'savings' as const,
      institution: 'bancolombia',
      last_four: '2651',
      currency: 'COP',
      balance: 0,
      is_active: true,
      color: null,
      icon: null,
      created_at: '',
      updated_at: '',
      identifiers: [
        { kind: 'bank_account' as const, last_four: '2651', is_active: true, is_primary: true },
        { kind: 'debit_card' as const, last_four: '9989', is_active: true, is_primary: false },
        { kind: 'debit_card' as const, last_four: '7799', is_active: false, is_primary: false }
      ]
    };
    const rules = service.generateAccountRules('owner', [account]);
    expect(rules.map((rule) => rule.conditions.raw_text_contains)).toEqual([
      ['bancolombia', '2651'],
      ['bancolombia', '9989']
    ]);
  });

  describe('unique pre-parse account detection', () => {
    it('declines ambiguous matches even when one rule has higher priority', () => {
      const first = createMockAutomationRule({
        rule_type: 'account_detection',
        priority: 100,
        conditions: { raw_text_contains: ['bank'] },
        actions: { set_account: 'account-a' }
      });
      const second = createMockAutomationRule({
        rule_type: 'account_detection',
        priority: 10,
        conditions: { raw_text_contains: ['bank', '1234'] },
        actions: { set_account: 'account-b' }
      });
      expect(service.findUniqueAccountDetectionRule([first, second], 'Bank 1234')).toBeNull();
    });
    it('keeps the first matching rule when aliases resolve to the same account and ignores nonmatches', () => {
      const first = createMockAutomationRule({
        rule_type: 'account_detection',
        conditions: { raw_text_contains: ['bank'] },
        actions: { set_account: 'account-a' }
      });
      const alias = createMockAutomationRule({
        rule_type: 'account_detection',
        conditions: { raw_text_contains: ['1234'] },
        actions: { set_account: 'account-a' }
      });
      const other = createMockAutomationRule({
        rule_type: 'account_detection',
        conditions: { raw_text_contains: ['other'] },
        actions: { set_account: 'account-b' }
      });
      expect(service.findUniqueAccountDetectionRule([first, alias, other], 'Bank 1234')).toEqual(
        first
      );
      expect(service.findUniqueAccountDetectionRule([first], 'Unrelated')).toBeNull();
    });
  });

  describe('getAutomationRules', () => {
    it('returns active rules', async () => {
      const rules = [createMockAutomationRule()];
      vi.stubGlobal('fetch', createMockFetch({ automation_rules: { data: rules } }));

      const result = await service.getAutomationRules('test-user-id');
      expect(result).toEqual(rules);
    });
  });

  describe('findTransferRule', () => {
    it('returns matching rule for phone', async () => {
      const rule = createMockAutomationRule({ match_phone: '3104633357' });
      vi.stubGlobal('fetch', createMockFetch({ automation_rules: { data: [rule] } }));

      const result = await service.findTransferRule('3104633357', 'test-user-id');
      expect(result).toEqual(rule);
    });

    it('strips leading * from phone', async () => {
      const rule = createMockAutomationRule({ match_phone: '3104633357' });
      const mockFn = createMockFetch({ automation_rules: { data: [rule] } });
      vi.stubGlobal('fetch', mockFn);

      await service.findTransferRule('*3104633357', 'test-user-id');
      const calledUrl = mockFn.mock.calls[0][0] as string;
      expect(calledUrl).toContain('match_phone=eq.3104633357');
    });

    it('returns null when no match', async () => {
      vi.stubGlobal('fetch', createMockFetch({ automation_rules: { data: [] } }));

      const result = await service.findTransferRule('0000000000', 'test-user-id');
      expect(result).toBeNull();
    });
  });

  describe('matchesConditions (via applyAutomationRules)', () => {
    function setupRulesAndApply(
      rule: ReturnType<typeof createMockAutomationRule>,
      tx: ReturnType<typeof createMockTransactionInput>
    ) {
      vi.stubGlobal('fetch', createMockFetch({ automation_rules: { data: [rule] } }));
      return service.applyAutomationRules(tx, 'test-user-id');
    }

    it('matches description_contains', async () => {
      const rule = createMockAutomationRule({
        conditions: { description_contains: ['restaurante'] },
        actions: { set_type: 'income' }
      });
      const tx = createMockTransactionInput({ description: 'Almuerzo en Restaurante' });
      const result = await setupRulesAndApply(rule, tx);
      expect(result.type).toBe('income');
    });

    it('does not match if description does not contain keyword', async () => {
      const rule = createMockAutomationRule({
        conditions: { description_contains: ['uber'] },
        actions: { set_type: 'income' }
      });
      const tx = createMockTransactionInput({ description: 'Almuerzo restaurante' });
      const result = await setupRulesAndApply(rule, tx);
      expect(result.type).toBe('expense');
    });

    it('matches description_regex', async () => {
      const rule = createMockAutomationRule({
        conditions: { description_regex: '^Nomina.*' },
        actions: { set_type: 'income' }
      });
      const tx = createMockTransactionInput({ description: 'Nomina Enero 2024' });
      const result = await setupRulesAndApply(rule, tx);
      expect(result.type).toBe('income');
    });

    it('does not match description_regex when it fails', async () => {
      const rule = createMockAutomationRule({
        conditions: { description_regex: '^Nomina.*' },
        actions: { set_type: 'income' }
      });
      const tx = createMockTransactionInput({ description: 'Compra almacen' });
      const result = await setupRulesAndApply(rule, tx);
      expect(result.type).toBe('expense');
    });

    it('does not match raw_text_contains when missing', async () => {
      const rule = createMockAutomationRule({
        conditions: { raw_text_contains: ['bancolombia'] },
        actions: { add_note: 'from bank' }
      });
      const tx = createMockTransactionInput({ raw_text: 'Other bank message' });
      const result = await setupRulesAndApply(rule, tx);
      expect(result.notes).toBeUndefined();
    });

    it('does not match source when not in list', async () => {
      const rule = createMockAutomationRule({
        conditions: { source: ['bancolombia_email'] },
        actions: { add_note: 'email source' }
      });
      const tx = createMockTransactionInput({ source: 'api' });
      const result = await setupRulesAndApply(rule, tx);
      expect(result.notes).toBeUndefined();
    });

    it('does not match from_account when different', async () => {
      const rule = createMockAutomationRule({
        conditions: { from_account: 'acc-99' },
        actions: { set_type: 'transfer' }
      });
      const tx = createMockTransactionInput({ account_id: 'acc-1' });
      const result = await setupRulesAndApply(rule, tx);
      expect(result.type).toBe('expense');
    });

    it('does not match amount_equals when different', async () => {
      const rule = createMockAutomationRule({
        conditions: { amount_equals: 99999 },
        actions: { add_note: 'exact match' }
      });
      const tx = createMockTransactionInput({ amount: 50000 });
      const result = await setupRulesAndApply(rule, tx);
      expect(result.notes).toBeUndefined();
    });

    it('matches raw_text_contains', async () => {
      const rule = createMockAutomationRule({
        conditions: { raw_text_contains: ['bancolombia'] },
        actions: { add_note: 'from bank' }
      });
      const tx = createMockTransactionInput({ raw_text: 'Bancolombia: Compraste $50,000' });
      const result = await setupRulesAndApply(rule, tx);
      expect(result.notes).toBe('from bank');
    });

    it('matches amount_between', async () => {
      const rule = createMockAutomationRule({
        conditions: { amount_between: [10000, 100000] },
        actions: { set_category: 'medium-expense' }
      });
      const tx = createMockTransactionInput({ amount: 50000 });
      const result = await setupRulesAndApply(rule, tx);
      expect(result.category_id).toBe('medium-expense');
    });

    it('does not match amount outside range', async () => {
      const rule = createMockAutomationRule({
        conditions: { amount_between: [10000, 100000] },
        actions: { set_category: 'medium-expense' }
      });
      const tx = createMockTransactionInput({ amount: 200000, category_id: 'original' });
      const result = await setupRulesAndApply(rule, tx);
      expect(result.category_id).toBe('original');
    });

    it('matches amount_equals', async () => {
      const rule = createMockAutomationRule({
        conditions: { amount_equals: 50000 },
        actions: { add_note: 'exact match' }
      });
      const tx = createMockTransactionInput({ amount: 50000 });
      const result = await setupRulesAndApply(rule, tx);
      expect(result.notes).toBe('exact match');
    });

    it('matches from_account', async () => {
      const rule = createMockAutomationRule({
        conditions: { from_account: 'acc-1' },
        actions: { set_type: 'transfer' }
      });
      const tx = createMockTransactionInput({ account_id: 'acc-1' });
      const result = await setupRulesAndApply(rule, tx);
      expect(result.type).toBe('transfer');
    });

    it('matches source condition', async () => {
      const rule = createMockAutomationRule({
        conditions: { source: ['bancolombia_email'] },
        actions: { add_note: 'email source' }
      });
      const tx = createMockTransactionInput({ source: 'bancolombia_email' });
      const result = await setupRulesAndApply(rule, tx);
      expect(result.notes).toBe('email source');
    });
  });

  describe('applyActions (via applyAutomationRules)', () => {
    it('applies set_type', async () => {
      const rule = createMockAutomationRule({
        conditions: {},
        actions: { set_type: 'income' }
      });
      vi.stubGlobal('fetch', createMockFetch({ automation_rules: { data: [rule] } }));

      const tx = createMockTransactionInput();
      const result = await service.applyAutomationRules(tx, 'test-user-id');
      expect(result.type).toBe('income');
    });

    it('applies set_category', async () => {
      const rule = createMockAutomationRule({
        conditions: {},
        actions: { set_category: 'food' }
      });
      vi.stubGlobal('fetch', createMockFetch({ automation_rules: { data: [rule] } }));

      const result = await service.applyAutomationRules(
        createMockTransactionInput(),
        'test-user-id'
      );
      expect(result.category_id).toBe('food');
    });

    it('applies link_to_account and generates transfer_id', async () => {
      const rule = createMockAutomationRule({
        conditions: {},
        actions: { link_to_account: 'acc-dest' }
      });
      vi.stubGlobal('fetch', createMockFetch({ automation_rules: { data: [rule] } }));

      const result = await service.applyAutomationRules(
        createMockTransactionInput(),
        'test-user-id'
      );
      expect(result.transfer_to_account_id).toBe('acc-dest');
      expect(result.transfer_id).toBeDefined();
    });

    it('applies set_account', async () => {
      const rule = createMockAutomationRule({
        conditions: {},
        actions: { set_account: 'acc-new' }
      });
      vi.stubGlobal('fetch', createMockFetch({ automation_rules: { data: [rule] } }));

      const result = await service.applyAutomationRules(
        createMockTransactionInput(),
        'test-user-id'
      );
      expect(result.account_id).toBe('acc-new');
    });

    it('injects transfer_to_account_id from rule when actions lack link_to_account', async () => {
      const rule = createMockAutomationRule({
        conditions: {},
        actions: { set_type: 'transfer' },
        transfer_to_account_id: 'acc-transfer-dest'
      });
      vi.stubGlobal('fetch', createMockFetch({ automation_rules: { data: [rule] } }));

      const result = await service.applyAutomationRules(
        createMockTransactionInput(),
        'test-user-id'
      );
      expect(result.transfer_to_account_id).toBe('acc-transfer-dest');
    });

    it('applies add_note', async () => {
      const rule = createMockAutomationRule({
        conditions: {},
        actions: { add_note: 'automated' }
      });
      vi.stubGlobal('fetch', createMockFetch({ automation_rules: { data: [rule] } }));

      const result = await service.applyAutomationRules(
        createMockTransactionInput(),
        'test-user-id'
      );
      expect(result.notes).toBe('automated');
    });

    it('appends note to existing notes', async () => {
      const rule = createMockAutomationRule({
        conditions: {},
        actions: { add_note: 'automated' }
      });
      vi.stubGlobal('fetch', createMockFetch({ automation_rules: { data: [rule] } }));

      const result = await service.applyAutomationRules(
        createMockTransactionInput({ notes: 'existing' }),
        'test-user-id'
      );
      expect(result.notes).toBe('existing\nautomated');
    });

    it('tracks applied rules', async () => {
      const rule = createMockAutomationRule({
        id: 'rule-1',
        name: 'Test Rule',
        conditions: {},
        actions: { set_type: 'income' }
      });
      vi.stubGlobal('fetch', createMockFetch({ automation_rules: { data: [rule] } }));

      const result = await service.applyAutomationRules(
        createMockTransactionInput(),
        'test-user-id'
      );
      expect(result.applied_rules).toHaveLength(1);
      expect(result.applied_rules![0].rule_id).toBe('rule-1');
      expect(result.applied_rules![0].rule_name).toBe('Test Rule');
    });
  });
});
