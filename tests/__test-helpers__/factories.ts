import { vi } from 'vitest';
import type { Transaction, CreateTransactionInput, Account, Category, AutomationRule, UsageTracking } from '../../src/types';

export function createMockTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    user_id: 'test-user-id',
    date: '2024-01-15',
    time: '14:30',
    amount: 50000,
    description: 'Almuerzo restaurante',
    notes: null,
    category_id: 'cat-1',
    account_id: 'acc-1',
    type: 'expense',
    payment_method: 'debit_card',
    source: 'api',
    confidence: 95,
    transfer_to_account_id: null,
    transfer_id: null,
    is_reconciled: false,
    reconciled_at: null,
    reconciliation_id: null,
    raw_text: 'Compraste $50,000 en restaurante',
    parsed_data: null,
    applied_rules: null,
    duplicate_status: null,
    duplicate_of: null,
    created_at: '2024-01-15T19:30:00Z',
    updated_at: '2024-01-15T19:30:00Z',
    ...overrides,
  };
}

export function createMockTransactionInput(
  overrides: Partial<CreateTransactionInput> = {},
): CreateTransactionInput {
  return {
    user_id: 'test-user-id',
    date: '2024-01-15',
    time: '14:30',
    amount: 50000,
    description: 'Almuerzo restaurante',
    account_id: 'acc-1',
    type: 'expense',
    source: 'api',
    ...overrides,
  };
}

export function createMockAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    user_id: 'test-user-id',
    name: 'Bancolombia Savings',
    type: 'savings',
    institution: 'bancolombia',
    last_four: '2651',
    currency: 'COP',
    balance: 1000000,
    is_active: true,
    color: null,
    icon: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

export function createMockCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: 'cat-1',
    user_id: 'test-user-id',
    name: 'Food',
    slug: 'food',
    type: 'expense',
    parent_id: null,
    icon: null,
    color: null,
    is_active: true,
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

export function createMockAutomationRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rule-1',
    user_id: 'test-user-id',
    name: 'Test Rule',
    is_active: true,
    priority: 1,
    prompt_text: null,
    match_phone: null,
    transfer_to_account_id: null,
    conditions: {},
    actions: {},
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

export function createMockEnv() {
  return {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_KEY: 'test-service-key',
    GEMINI_API_KEY: 'test-gemini-key',
    TELEGRAM_BOT_TOKEN: 'test-telegram-token',
    API_KEY: 'test-api-key',
    DEFAULT_USER_ID: 'test-user-id',
    REDIS_URL: 'redis://localhost:6379',
    REDIS_PASSWORD: 'test-password',
  };
}

export function createMockUsage(overrides: Partial<UsageTracking> = {}): UsageTracking {
  return {
    id: 'usage-1',
    user_id: 'test-user-id',
    month: new Date().toISOString().slice(0, 7),
    ai_parses_used: 5,
    ai_parses_limit: 15,
    transactions_count: 10,
    transactions_limit: 50,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

type MockResponse = {
  data: unknown;
  status?: number;
  ok?: boolean;
};

export function createMockFetch(responses: Record<string, MockResponse>) {
  return vi.fn(async (url: string | URL | Request, _options?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

    for (const [pathPattern, response] of Object.entries(responses)) {
      if (urlStr.includes(pathPattern)) {
        const status = response.status ?? 200;
        const ok = response.ok ?? (status >= 200 && status < 300);
        return new Response(JSON.stringify(response.data), {
          status,
          statusText: ok ? 'OK' : 'Error',
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}
