import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseExpense as parseExpenseWithConsent } from '../../src/parsers/expense';
import type { CacheService } from '../../src/services/cache.service';
import type { AiUsageService } from '../../src/services/supabase/ai-usage.service';
import { AiUsageMeter } from '../../src/ai/usage-meter';
import { ConsentGatedAiUsageService } from '../../src/services/supabase/consent-gated-ai-usage.service';
import {
  AiConsentRequiredError,
  AiConsentUnavailableError
} from '../../src/services/supabase/ai-consent.service';

const API_KEY = 'test-openrouter-key';
const approvedService = {
  requireConsent: async () => undefined,
  track: async <T>(_params: unknown, task: (meter: AiUsageMeter) => Promise<T>): Promise<T> =>
    task(new AiUsageMeter())
} as AiUsageService;
const parseExpense: typeof parseExpenseWithConsent = (text, apiKey, cache, options) =>
  parseExpenseWithConsent(text, apiKey, cache, {
    ...options,
    telemetry: options?.telemetry ?? { userId: 'owner-1', service: approvedService }
  });

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

  it('never calls OpenRouter without owner-scoped consent telemetry', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(parseExpenseWithConsent('Compraste $50.000', API_KEY)).rejects.toBeInstanceOf(
      AiConsentUnavailableError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps incoming-transfer review local without AI consent', async () => {
    const beforeExternalCall = vi.fn();
    const requireConsent = vi.fn(async () => {
      throw new AiConsentRequiredError('financial_text');
    });
    const service = new ConsentGatedAiUsageService('https://db.test', 'key', {
      require: requireConsent
    });
    const fetchMock = vi.fn(async () => Response.json([]));
    vi.stubGlobal('fetch', fetchMock);
    const result = await parseExpense(
      'Bancolombia: Recibiste una transferencia por $50.000',
      API_KEY,
      undefined,
      { telemetry: { userId: 'owner-1', service }, beforeExternalCall }
    );
    expect(result.skip_reason).toBe('incoming_transfer_requires_review');
    expect(requireConsent).not.toHaveBeenCalled();
    expect(beforeExternalCall).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('openrouter.ai'))).toBe(false);
  });

  it('returns a cached parse without AI consent but denies a cache miss before OpenRouter', async () => {
    const beforeExternalCall = vi.fn();
    const requireConsent = vi.fn(async () => {
      throw new AiConsentRequiredError('financial_text');
    });
    const service = new ConsentGatedAiUsageService('https://db.test', 'key', {
      require: requireConsent
    });
    const fetchMock = vi.fn(async () => Response.json([]));
    vi.stubGlobal('fetch', fetchMock);
    const cache = {
      hashKey: vi.fn().mockReturnValue('cache-key'),
      get: vi.fn().mockResolvedValueOnce(JSON.stringify(validExpense)).mockResolvedValueOnce(null),
      set: vi.fn()
    } as unknown as CacheService;
    const options = { telemetry: { userId: 'owner-1', service }, beforeExternalCall };
    expect((await parseExpense('Compraste $50.000', API_KEY, cache, options)).amount).toBe(50000);
    expect(requireConsent).not.toHaveBeenCalled();
    await expect(parseExpense('Compraste $50.000', API_KEY, cache, options)).rejects.toBeInstanceOf(
      AiConsentRequiredError
    );
    expect(requireConsent).toHaveBeenCalledWith('owner-1', 'financial_text');
    expect(beforeExternalCall).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('openrouter.ai'))).toBe(false);
  });

  it('reserves quota only after consent and immediately before an external call', async () => {
    const order: string[] = [];
    const service = new ConsentGatedAiUsageService('https://db.test', 'key', {
      require: async () => {
        order.push('consent');
      }
    });
    const beforeExternalCall = vi.fn(async () => {
      order.push('quota');
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        order.push('provider');
        return Response.json(createOpenRouterResponse(validExpense));
      })
    );
    await parseExpense('Compraste $50.000', API_KEY, undefined, {
      telemetry: { userId: 'owner-1', service },
      beforeExternalCall
    });
    expect(order.slice(0, 3)).toEqual(['consent', 'quota', 'provider']);
    expect(beforeExternalCall).toHaveBeenCalledOnce();
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
