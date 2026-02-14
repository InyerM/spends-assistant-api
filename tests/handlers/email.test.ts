import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleEmail } from '../../src/handlers/email';
import {
  createMockEnv,
  createMockAccount,
  createMockCategory,
  createMockTransaction,
} from '../__test-helpers__/factories';

vi.mock('../../src/parsers/gemini', () => ({
  parseExpense: vi.fn(),
}));

describe('handleEmail', () => {
  const env = createMockEnv();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('ignores non-Bancolombia emails', async () => {
    const request = new Request('http://localhost/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'Some other email content' }),
    });

    const response = await handleEmail(request, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ignored');
    expect(body.reason).toBe('not_bancolombia');
  });

  it('processes valid Bancolombia email', async () => {
    const account = createMockAccount();
    const category = createMockCategory({ slug: 'food' });
    const savedTx = createMockTransaction();

    const { parseExpense } = await import('../../src/parsers/gemini');
    vi.mocked(parseExpense).mockResolvedValue({
      amount: 50000,
      description: 'Compra restaurante',
      category: 'food',
      bank: 'bancolombia',
      payment_type: 'debit_card',
      source: 'email',
      confidence: 90,
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
        return new Response(JSON.stringify([savedTx]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const request = new Request('http://localhost/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: 'Bancolombia: Compraste $50,000 en restaurante con tu tarjeta *2651',
      }),
    });

    const response = await handleEmail(request, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('success');
    expect(body.expense.amount).toBe(50000);
  });

  it('returns error when text extraction fails', async () => {
    const request = new Request('http://localhost/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'Bancolombia aviso general sin montos' }),
    });

    const response = await handleEmail(request, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('error');
    expect(body.reason).toBe('no_text_extracted');
  });

  it('returns 400 for non-JSON content type', async () => {
    const request = new Request('http://localhost/email', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'plain text',
    });

    const response = await handleEmail(request, env);
    expect(response.status).toBe(400);
  });

  it('processes transfer email creating dual transactions', async () => {
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
      source: 'email',
      confidence: 90,
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
        return new Response(JSON.stringify([savedTx]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const request = new Request('http://localhost/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: 'Bancolombia: Transferiste $100,000 a *3104633357 desde tu cuenta 2651',
      }),
    });

    const response = await handleEmail(request, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('success');
  });

  it('uses subject or text fallback when body is missing', async () => {
    const request = new Request('http://localhost/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'Alert from Bancolombia: Compraste $10,000 en tienda' }),
    });

    // This should extract bancolombia text from subject
    const { parseExpense } = await import('../../src/parsers/gemini');
    vi.mocked(parseExpense).mockResolvedValue({
      amount: 10000,
      description: 'Tienda',
      category: 'shopping',
      bank: 'bancolombia',
      payment_type: 'debit_card',
      source: 'email',
      confidence: 85,
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
        return new Response(JSON.stringify([createMockAccount()]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('categories')) {
        return new Response(JSON.stringify([createMockCategory()]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('transactions')) {
        return new Response(JSON.stringify([createMockTransaction()]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const response = await handleEmail(request, env);
    expect(response.status).toBe(200);
  });

  it('uses original_date and original_time when present', async () => {
    const account = createMockAccount();
    const category = createMockCategory();
    const savedTx = createMockTransaction();

    const { parseExpense } = await import('../../src/parsers/gemini');
    vi.mocked(parseExpense).mockResolvedValue({
      amount: 50000,
      description: 'Compra',
      category: 'food',
      bank: 'bancolombia',
      payment_type: 'debit_card',
      source: 'email',
      confidence: 90,
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
      if (url.includes('transactions') && options?.method === 'POST') {
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
    }));

    const request = new Request('http://localhost/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: 'Bancolombia: Compraste $50,000 en restaurante con tu tarjeta *2651',
      }),
    });

    const response = await handleEmail(request, env);
    expect(response.status).toBe(200);
    const parsed = JSON.parse(postedBody!);
    expect(parsed.date).toBe('2024-01-15');
    expect(parsed.time).toBe('14:30');
    expect(parsed.user_id).toBe('test-user-id');
  });

  it('returns 500 on service error', async () => {
    const { parseExpense } = await import('../../src/parsers/gemini');
    vi.mocked(parseExpense).mockRejectedValue(new Error('Parse error'));

    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    const request = new Request('http://localhost/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: 'Bancolombia: Compraste $50,000 en restaurante con tu tarjeta *2651',
      }),
    });

    const response = await handleEmail(request, env);
    expect(response.status).toBe(500);
  });
});
