import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleParse } from '../../src/handlers/parse';
import { createMockEnv, createMockAccount, createMockCategory } from '../__test-helpers__/factories';

vi.mock('../../src/parsers/gemini', () => ({
  parseExpense: vi.fn(),
}));

describe('handleParse', () => {
  const env = createMockEnv();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 without auth header', async () => {
    const request = new Request('http://localhost/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'test' }),
    });
    const response = await handleParse(request, env);
    expect(response.status).toBe(401);
  });

  it('returns 401 with wrong API key', async () => {
    const request = new Request('http://localhost/parse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-key',
      },
      body: JSON.stringify({ text: 'test' }),
    });
    const response = await handleParse(request, env);
    expect(response.status).toBe(401);
  });

  it('returns 400 when text is missing', async () => {
    const request = new Request('http://localhost/parse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.API_KEY}`,
      },
      body: JSON.stringify({}),
    });
    const response = await handleParse(request, env);
    expect(response.status).toBe(400);
  });

  it('returns parsed expense with resolved IDs', async () => {
    const account = createMockAccount();
    const category = createMockCategory({ slug: 'food' });
    const parsedExpense = {
      amount: 50000,
      description: 'Lunch',
      category: 'food',
      bank: 'bancolombia',
      payment_type: 'debit_card',
      source: 'sms',
      confidence: 95,
      last_four: '2651',
      account_type: 'savings' as const,
    };

    // Mock: dynamic import of parseExpense
    const { parseExpense } = await import('../../src/parsers/gemini');
    vi.mocked(parseExpense).mockResolvedValue(parsedExpense);

    // Mock supabase fetch for rules + accounts + categories
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('automation_rules')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('accounts')) {
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
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const request = new Request('http://localhost/parse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.API_KEY}`,
      },
      body: JSON.stringify({ text: 'Compraste $50,000 en restaurante' }),
    });

    const response = await handleParse(request, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.parsed.amount).toBe(50000);
    expect(body.resolved.account_id).toBe(account.id);
    expect(body.resolved.category_id).toBe(category.id);
  });

  it('returns 500 on error', async () => {
    const { parseExpense } = await import('../../src/parsers/gemini');
    vi.mocked(parseExpense).mockRejectedValue(new Error('Gemini API Error'));

    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    const request = new Request('http://localhost/parse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.API_KEY}`,
      },
      body: JSON.stringify({ text: 'test' }),
    });

    const response = await handleParse(request, env);
    expect(response.status).toBe(500);
  });
});
