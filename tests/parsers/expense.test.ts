import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseExpense } from '../../src/parsers/expense';
import type { CacheService } from '../../src/services/cache.service';

const API_KEY = 'test-openrouter-key';

function createOpenRouterResponse(expense: Record<string, unknown>) {
  return {
    choices: [{ message: { content: JSON.stringify(expense) }, finish_reason: 'stop' }]
  };
}

const validExpense = {
  amount: 50000,
  description: 'Almuerzo restaurante',
  category: 'food',
  bank: 'bancolombia',
  payment_type: 'debit_card',
  source: 'sms',
  confidence: 95
};

describe('parseExpense', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal(
      'setTimeout',
      vi.fn((cb: () => void) => {
        cb();
        return 1;
      })
    );
    vi.stubGlobal('clearTimeout', vi.fn());
  });

  it.each([
    [
      'Bancolombia: Recibiste un pago de Nomina por $3.100.000 en tu cuenta AHORROS',
      'incoming_payment_requires_review'
    ],
    [
      'Bancolombia: CLIENTE, recibiste una transferencia por $50.000 en tu cuenta AHORROS',
      'incoming_transfer_requires_review'
    ],
    [
      'Bancolombia: Recibiste un pago por $130.000 a tu cuenta AHORROS',
      'incoming_payment_requires_review'
    ],
    [
      'Bancolombia: Recibiste la devolucion de $24.000 en tu tarjeta de credito',
      'incoming_refund_requires_review'
    ]
  ])('holds a received bank notification for review: %s', async (text, reason) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const cache = {
      hashKey: vi.fn().mockReturnValue('stale'),
      get: vi.fn().mockResolvedValue(JSON.stringify(validExpense)),
      set: vi.fn()
    } as unknown as CacheService;

    const result = await parseExpense(text, API_KEY, cache);

    expect(result.is_transaction).toBe(false);
    expect(result.skip_reason).toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('does not hold a sent transfer for incoming review', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(createOpenRouterResponse(validExpense)), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await parseExpense(
      'Bancolombia: Enviaste una transferencia por $50.000',
      API_KEY
    );

    expect(result.is_transaction).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('parses valid response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(createOpenRouterResponse(validExpense)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
      )
    );

    const result = await parseExpense('Compraste $50,000', API_KEY);
    expect(result.amount).toBe(50000);
    expect(result.description).toBe('Almuerzo restaurante');
    expect(result.category).toBe('food');
  });

  it('uses cache hit when available', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const cache = {
      hashKey: vi.fn().mockReturnValue('hash123'),
      get: vi.fn().mockResolvedValue(JSON.stringify(validExpense)),
      set: vi.fn()
    } as unknown as CacheService;

    const result = await parseExpense('Compraste $50,000', API_KEY, cache);
    expect(result.amount).toBe(50000);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('saves to cache on miss', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(createOpenRouterResponse(validExpense)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
      )
    );

    const cache = {
      hashKey: vi.fn().mockReturnValue('hash123'),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn()
    } as unknown as CacheService;

    await parseExpense('Compraste $50,000', API_KEY, cache);
    expect(cache.set).toHaveBeenCalled();
  });

  it('retries on 429 and succeeds', async () => {
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response('Rate limited', { status: 429 });
        }
        return new Response(JSON.stringify(createOpenRouterResponse(validExpense)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );

    const result = await parseExpense('Compraste $50,000', API_KEY);
    expect(result.amount).toBe(50000);
    expect(callCount).toBe(2);
  });

  it('throws after max 429 retries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Rate limited', { status: 429 }))
    );

    await expect(parseExpense('Compraste $50,000', API_KEY)).rejects.toThrow(
      'OpenRouter request failed (429)'
    );
  });

  it('throws on non-200 error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Server error', { status: 500 }))
    );

    await expect(parseExpense('test', API_KEY)).rejects.toThrow('OpenRouter request failed');
  });

  it('throws on a truncated completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ finish_reason: 'length', message: { content: '{' } }]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      )
    );

    await expect(parseExpense('test', API_KEY)).rejects.toThrow('truncated');
  });

  it('throws on invalid JSON response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: 'not json' }, finish_reason: 'stop' }]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      )
    );

    await expect(parseExpense('test', API_KEY)).rejects.toThrow();
  });

  it('throws on amount <= 0', async () => {
    const badExpense = { ...validExpense, amount: 0 };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(createOpenRouterResponse(badExpense)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
      )
    );

    await expect(parseExpense('test', API_KEY)).rejects.toThrow('Invalid amount');
  });

  it('throws on empty description', async () => {
    const badExpense = { ...validExpense, description: '' };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(createOpenRouterResponse(badExpense)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
      )
    );

    await expect(parseExpense('test', API_KEY)).rejects.toThrow('Missing description');
  });

  it('throws on missing category', async () => {
    const badExpense = { ...validExpense, category: '' };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(createOpenRouterResponse(badExpense)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
      )
    );

    await expect(parseExpense('test', API_KEY)).rejects.toThrow('Missing category');
  });

  it('includes dynamic prompts in request', async () => {
    const mockFetch = vi.fn(
      async () =>
        new Response(JSON.stringify(createOpenRouterResponse(validExpense)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    );
    vi.stubGlobal('fetch', mockFetch);

    await parseExpense('test', API_KEY, undefined, {
      dynamicPrompts: ['Custom rule 1']
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    const promptText = body.messages[0].content;
    expect(promptText).toContain('Custom rule 1');
  });

  it('maps a model category outside the user catalog to missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(createOpenRouterResponse({ ...validExpense, category: 'restaurant' })),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            }
          )
      )
    );

    const result = await parseExpense('Compraste $50,000', API_KEY, undefined, {
      categoryCatalog: [{ slug: 'custom-lunch', name: 'Lunch at work', type: 'expense' }]
    });
    expect(result.category).toBe('missing');
  });
});
