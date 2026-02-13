import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractPhoneNumber,
  extractOriginAccount,
  isTransferMessage,
  processTransfer,
  buildTransferPromptSection,
  buildAutomationRulesPromptSection,
} from '../../src/services/transfer-processor';
import {
  createMockAutomationRule,
  createMockTransactionInput,
  createMockCategory,
} from '../__test-helpers__/factories';
import type { SupabaseServices } from '../../src/services/supabase';

describe('extractPhoneNumber', () => {
  it('extracts phone with * prefix', () => {
    expect(extractPhoneNumber('Transferiste a *3104633357')).toBe('3104633357');
  });

  it('extracts phone after "cuenta"', () => {
    expect(extractPhoneNumber('la cuenta *3104633357')).toBe('3104633357');
  });

  it('extracts phone after "a"', () => {
    expect(extractPhoneNumber('enviaste a 3104633357 desde tu cuenta')).toBe('3104633357');
  });

  it('returns null when no phone found', () => {
    expect(extractPhoneNumber('Compraste en almacen')).toBeNull();
  });
});

describe('extractOriginAccount', () => {
  it('extracts last 4 digits after "desde tu cuenta"', () => {
    expect(extractOriginAccount('desde tu cuenta 2651')).toBe('2651');
  });

  it('extracts from "cuenta XXXX a la"', () => {
    expect(extractOriginAccount('cuenta 2651 a la cuenta')).toBe('2651');
  });

  it('returns null when no origin found', () => {
    expect(extractOriginAccount('Compraste en tienda')).toBeNull();
  });
});

describe('isTransferMessage', () => {
  it('detects "transferiste"', () => {
    expect(isTransferMessage('Transferiste $50,000')).toBe(true);
  });

  it('detects "enviaste"', () => {
    expect(isTransferMessage('Enviaste $100,000 a cuenta')).toBe(true);
  });

  it('detects "transferencia"', () => {
    expect(isTransferMessage('Se realizó transferencia')).toBe(true);
  });

  it('returns false for purchase message', () => {
    expect(isTransferMessage('Compraste en restaurante')).toBe(false);
  });
});

describe('processTransfer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function createMockServices(overrides: {
    findTransferRule?: ReturnType<typeof vi.fn>;
    getCategory?: ReturnType<typeof vi.fn>;
  } = {}): SupabaseServices {
    return {
      automationRules: {
        findTransferRule: overrides.findTransferRule ?? vi.fn().mockResolvedValue(null),
      },
      categories: {
        getCategory: overrides.getCategory ?? vi.fn().mockResolvedValue(null),
      },
      accounts: {} as SupabaseServices['accounts'],
      transactions: {} as SupabaseServices['transactions'],
    } as unknown as SupabaseServices;
  }

  it('returns single expense when no phone found', async () => {
    const tx = createMockTransactionInput({ description: 'Compra almacen' });
    const services = createMockServices();

    const result = await processTransfer(tx, 'Compraste en almacen', services, 'cat-missing');
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].type).toBe('expense');
    expect(result.transactions[0].category_id).toBe('cat-missing');
    expect(result.transferInfo.destinationPhone).toBeNull();
  });

  it('returns single expense with note when phone found but no rule', async () => {
    const tx = createMockTransactionInput({ description: 'Transfer' });
    const services = createMockServices();

    const result = await processTransfer(
      tx,
      'Transferiste a *3104633357 desde tu cuenta 2651',
      services,
      'cat-missing',
    );
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].type).toBe('expense');
    expect(result.transactions[0].notes).toContain('3104633357');
    expect(result.transferInfo.destinationPhone).toBe('3104633357');
    expect(result.transferInfo.isInternalTransfer).toBe(false);
  });

  it('creates dual transactions when phone matches a rule', async () => {
    const tx = createMockTransactionInput({
      description: 'Transfer',
      amount: 100000,
      account_id: 'acc-source',
    });
    const rule = createMockAutomationRule({
      name: 'Nequi',
      match_phone: '3104633357',
      transfer_to_account_id: 'acc-dest',
    });
    const transferCategory = createMockCategory({ id: 'cat-transfer', slug: 'transfer' });

    const services = createMockServices({
      findTransferRule: vi.fn().mockResolvedValue(rule),
      getCategory: vi.fn().mockResolvedValue(transferCategory),
    });

    const result = await processTransfer(
      tx,
      'Transferiste a *3104633357 desde tu cuenta 2651',
      services,
    );

    expect(result.transactions).toHaveLength(2);
    // Outgoing
    expect(result.transactions[0].type).toBe('transfer');
    expect(result.transactions[0].account_id).toBe('acc-source');
    expect(result.transactions[0].transfer_to_account_id).toBe('acc-dest');
    expect(result.transactions[0].transfer_id).toBeDefined();
    // Incoming
    expect(result.transactions[1].type).toBe('transfer');
    expect(result.transactions[1].account_id).toBe('acc-dest');
    expect(result.transactions[1].transfer_id).toBe(result.transactions[0].transfer_id);
    // Transfer info
    expect(result.transferInfo.isInternalTransfer).toBe(true);
    expect(result.transferInfo.linkedAccountId).toBe('acc-dest');
    expect(result.transferInfo.ruleName).toBe('Nequi');
  });

  it('includes origin account in incoming transaction notes', async () => {
    const tx = createMockTransactionInput({ description: 'Transfer', account_id: 'acc-source' });
    const rule = createMockAutomationRule({
      name: 'Nequi',
      transfer_to_account_id: 'acc-dest',
    });

    const services = createMockServices({
      findTransferRule: vi.fn().mockResolvedValue(rule),
      getCategory: vi.fn().mockResolvedValue(null),
    });

    const result = await processTransfer(
      tx,
      'Transferiste a *3104633357 desde tu cuenta 2651',
      services,
    );

    expect(result.transactions[1].notes).toContain('2651');
  });

  it('appends to existing notes', async () => {
    const tx = createMockTransactionInput({ description: 'Transfer', notes: 'existing note' });
    const services = createMockServices();

    const result = await processTransfer(
      tx,
      'Compraste en almacen sin telefono',
      services,
      'cat-missing',
    );

    expect(result.transactions[0].notes).toContain('existing note');
    expect(result.transactions[0].notes).toContain('Transfer');
  });
});

describe('buildTransferPromptSection', () => {
  it('returns empty string for no rules', () => {
    expect(buildTransferPromptSection([])).toBe('');
  });

  it('returns empty string when no rules have match_phone', () => {
    const rules = [createMockAutomationRule({ match_phone: null })];
    expect(buildTransferPromptSection(rules)).toBe('');
  });

  it('includes phone mappings', () => {
    const rules = [
      createMockAutomationRule({ match_phone: '3104633357', name: 'Nequi' }),
    ];
    const result = buildTransferPromptSection(rules);
    expect(result).toContain('*3104633357');
    expect(result).toContain('TRANSFERS');
  });
});

describe('buildAutomationRulesPromptSection', () => {
  it('returns empty string for no rules', () => {
    expect(buildAutomationRulesPromptSection([])).toBe('');
  });

  it('returns empty for rules with match_phone (transfer rules excluded)', () => {
    const rules = [
      createMockAutomationRule({
        match_phone: '3104633357',
        conditions: { description_contains: ['test'] },
        actions: { set_type: 'income' },
      }),
    ];
    expect(buildAutomationRulesPromptSection(rules)).toBe('');
  });

  it('builds section for rules with conditions and actions', () => {
    const rules = [
      createMockAutomationRule({
        name: 'Salary',
        match_phone: null,
        conditions: { description_contains: ['nomina', 'salario'] },
        actions: { set_type: 'income', set_category: 'salary' },
      }),
    ];
    const result = buildAutomationRulesPromptSection(rules);
    expect(result).toContain('AUTOMATION RULES');
    expect(result).toContain('Salary');
    expect(result).toContain('nomina');
    expect(result).toContain('income');
  });

  it('includes amount_between condition', () => {
    const rules = [
      createMockAutomationRule({
        name: 'Big expense',
        match_phone: null,
        conditions: { amount_between: [100000, 500000] },
        actions: { set_category: 'large-purchase' },
      }),
    ];
    const result = buildAutomationRulesPromptSection(rules);
    expect(result).toContain('amount between 100000-500000');
  });

  it('includes description_regex condition', () => {
    const rules = [
      createMockAutomationRule({
        name: 'Regex rule',
        match_phone: null,
        conditions: { description_regex: '^Nomina.*' },
        actions: { set_type: 'income' },
      }),
    ];
    const result = buildAutomationRulesPromptSection(rules);
    expect(result).toContain('description matches /^Nomina.*/');
  });

  it('skips rules with no conditions or no actions', () => {
    const rules = [
      createMockAutomationRule({
        name: 'Empty rule',
        match_phone: null,
        conditions: {},
        actions: { set_type: 'income' },
      }),
    ];
    // No conditions means condParts is empty, so it returns ''
    expect(buildAutomationRulesPromptSection(rules)).toBe('');
  });

  it('includes source condition', () => {
    const rules = [
      createMockAutomationRule({
        name: 'Email rule',
        match_phone: null,
        conditions: { source: ['bancolombia_email'] },
        actions: { set_type: 'expense' },
      }),
    ];
    const result = buildAutomationRulesPromptSection(rules);
    expect(result).toContain('source is [bancolombia_email]');
  });
});
