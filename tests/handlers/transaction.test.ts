import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleTransaction } from '../../src/handlers/transaction';
import {
  createMockEnv,
  createMockAccount,
  createMockCategory,
  createMockTransaction,
} from '../__test-helpers__/factories';

vi.mock('../../src/parsers/gemini', () => ({
  parseExpense: vi.fn(),
}));

describe('handleTransaction', () => {
  const env = createMockEnv();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 without auth', async () => {
    const request = new Request('http://localhost/transaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'test' }),
    });
    const response = await handleTransaction(request, env);
    expect(response.status).toBe(401);
  });

  it('returns 400 when text is missing', async () => {
    const request = new Request('http://localhost/transaction', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.API_KEY}`,
      },
      body: JSON.stringify({}),
    });
    const response = await handleTransaction(request, env);
    expect(response.status).toBe(400);
  });

  it('creates an expense transaction', async () => {
    const account = createMockAccount();
    const category = createMockCategory({ slug: 'food' });
    const savedTx = createMockTransaction();

    const { parseExpense } = await import('../../src/parsers/gemini');
    vi.mocked(parseExpense).mockResolvedValue({
      amount: 50000,
      description: 'Almuerzo',
      category: 'food',
      bank: 'bancolombia',
      payment_type: 'debit_card',
      source: 'sms',
      confidence: 95,
    });

    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (url.includes('automation_rules')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('accounts')) {
        if (options?.method === 'PATCH') {
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify([account]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('categories')) {
        return new Response(JSON.stringify([category]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('transactions')) {
        if (options?.method === 'POST') {
          return new Response(JSON.stringify([savedTx]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        // Duplicate checks return empty
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const request = new Request('http://localhost/transaction', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.API_KEY}`,
      },
      body: JSON.stringify({ text: 'Compraste $50,000 en restaurante' }),
    });

    const response = await handleTransaction(request, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('success');
    expect(body.transaction).toBeDefined();
  });

  it('detects exact duplicate', async () => {
    const account = createMockAccount();
    const category = createMockCategory();
    const existingTx = createMockTransaction();

    const { parseExpense } = await import('../../src/parsers/gemini');
    vi.mocked(parseExpense).mockResolvedValue({
      amount: 50000,
      description: 'Almuerzo',
      category: 'food',
      bank: 'bancolombia',
      payment_type: 'debit_card',
      source: 'sms',
      confidence: 95,
    });

    let postBody: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (url.includes('automation_rules')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('accounts')) {
        if (options?.method === 'PATCH') {
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify([account]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('categories')) {
        return new Response(JSON.stringify([category]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('transactions')) {
        if (options?.method === 'POST') {
          postBody = options.body as string;
          return new Response(JSON.stringify([existingTx]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        // findExactDuplicate returns existing tx
        if (url.includes('raw_text=eq.')) {
          return new Response(JSON.stringify([existingTx]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const request = new Request('http://localhost/transaction', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.API_KEY}`,
      },
      body: JSON.stringify({ text: 'Compraste $50,000 en restaurante' }),
    });

    const response = await handleTransaction(request, env);
    expect(response.status).toBe(200);
    // The transaction is still created but with duplicate_status
    const parsed = JSON.parse(postBody!);
    expect(parsed.duplicate_status).toBe('pending_review');
    expect(parsed.duplicate_of).toBe(existingTx.id);
  });

  it('processes transfer message', async () => {
    const account = createMockAccount();
    const category = createMockCategory({ slug: 'transfer' });
    const savedTx = createMockTransaction();

    const { parseExpense } = await import('../../src/parsers/gemini');
    vi.mocked(parseExpense).mockResolvedValue({
      amount: 100000,
      description: 'Transferencia',
      category: 'transfer',
      bank: 'bancolombia',
      payment_type: 'debit_card',
      source: 'sms',
      confidence: 95,
    });

    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (url.includes('automation_rules')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('accounts')) {
        if (options?.method === 'PATCH') {
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify([account]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('categories')) {
        return new Response(JSON.stringify([category]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('transactions')) {
        if (options?.method === 'POST') {
          return new Response(JSON.stringify([savedTx]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const request = new Request('http://localhost/transaction', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.API_KEY}`,
      },
      body: JSON.stringify({
        text: 'Transferiste $100,000 a *3104633357 desde tu cuenta 2651',
      }),
    });

    const response = await handleTransaction(request, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('success');
    expect(body.transfer).toBeDefined();
  });

  it('uses original date/time from parsed expense', async () => {
    const account = createMockAccount();
    const category = createMockCategory();
    const savedTx = createMockTransaction();

    const { parseExpense } = await import('../../src/parsers/gemini');
    vi.mocked(parseExpense).mockResolvedValue({
      amount: 50000,
      description: 'Almuerzo',
      category: 'food',
      bank: 'bancolombia',
      payment_type: 'debit_card',
      source: 'sms',
      confidence: 95,
      original_date: '15/01/2024',
      original_time: '14:30',
    });

    let postedBody: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (url.includes('automation_rules')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('accounts')) {
        if (options?.method === 'PATCH') {
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify([account]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('categories')) {
        return new Response(JSON.stringify([category]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('transactions')) {
        if (options?.method === 'POST') {
          postedBody = options.body as string;
          return new Response(JSON.stringify([savedTx]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const request = new Request('http://localhost/transaction', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.API_KEY}`,
      },
      body: JSON.stringify({ text: 'Compraste $50,000 en restaurante' }),
    });

    const response = await handleTransaction(request, env);
    expect(response.status).toBe(200);
    const parsed = JSON.parse(postedBody!);
    expect(parsed.date).toBe('2024-01-15');
    expect(parsed.time).toBe('14:30');
  });

  it('falls back to default account when bank not found', async () => {
    const fallbackAccount = createMockAccount({ id: 'acc-cash', institution: 'cash' });
    const category = createMockCategory();
    const savedTx = createMockTransaction();

    const { parseExpense } = await import('../../src/parsers/gemini');
    vi.mocked(parseExpense).mockResolvedValue({
      amount: 50000,
      description: 'Almuerzo',
      category: 'food',
      bank: 'unknown-bank',
      payment_type: 'cash',
      source: 'manual',
      confidence: 80,
    });

    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (url.includes('automation_rules')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('accounts')) {
        if (options?.method === 'PATCH') {
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        callCount++;
        // First call: unknown bank → empty, second: cash → found
        if (callCount === 1) {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify([fallbackAccount]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('categories')) {
        return new Response(JSON.stringify([category]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('transactions')) {
        if (options?.method === 'POST') {
          return new Response(JSON.stringify([savedTx]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const request = new Request('http://localhost/transaction', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.API_KEY}`,
      },
      body: JSON.stringify({ text: 'Gasto $50,000 en almuerzo' }),
    });

    const response = await handleTransaction(request, env);
    expect(response.status).toBe(200);
  });

  it('returns 500 on error', async () => {
    const { parseExpense } = await import('../../src/parsers/gemini');
    vi.mocked(parseExpense).mockRejectedValue(new Error('API Error'));

    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    const request = new Request('http://localhost/transaction', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.API_KEY}`,
      },
      body: JSON.stringify({ text: 'test' }),
    });

    const response = await handleTransaction(request, env);
    expect(response.status).toBe(500);
  });
});
