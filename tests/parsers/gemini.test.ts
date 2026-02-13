import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseExpense } from '../../src/parsers/gemini';
import type { CacheService } from '../../src/services/cache.service';

const API_KEY = 'test-gemini-key';

function createGeminiResponse(expense: Record<string, unknown>) {
  return {
    candidates: [
      {
        content: {
          parts: [{ text: JSON.stringify(expense) }],
        },
        finishReason: 'STOP',
      },
    ],
  };
}

const validExpense = {
  amount: 50000,
  description: 'Almuerzo restaurante',
  category: 'food',
  bank: 'bancolombia',
  payment_type: 'debit_card',
  source: 'sms',
  confidence: 95,
};

describe('parseExpense', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('setTimeout', vi.fn((cb: () => void) => { cb(); return 1; }));
    vi.stubGlobal('clearTimeout', vi.fn());
  });

  it('parses valid response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(createGeminiResponse(validExpense)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

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
      set: vi.fn(),
    } as unknown as CacheService;

    const result = await parseExpense('Compraste $50,000', API_KEY, cache);
    expect(result.amount).toBe(50000);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('saves to cache on miss', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(createGeminiResponse(validExpense)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    const cache = {
      hashKey: vi.fn().mockReturnValue('hash123'),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
    } as unknown as CacheService;

    await parseExpense('Compraste $50,000', API_KEY, cache);
    expect(cache.set).toHaveBeenCalled();
  });

  it('retries on 429 and succeeds', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('Rate limited', { status: 429 });
      }
      return new Response(JSON.stringify(createGeminiResponse(validExpense)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const result = await parseExpense('Compraste $50,000', API_KEY);
    expect(result.amount).toBe(50000);
    expect(callCount).toBe(2);
  });

  it('throws after max 429 retries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('Rate limited', { status: 429 }),
    ));

    await expect(parseExpense('Compraste $50,000', API_KEY)).rejects.toThrow(
      'Rate limit exceeded',
    );
  });

  it('throws on non-200 error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('Server error', { status: 500 }),
    ));

    await expect(parseExpense('test', API_KEY)).rejects.toThrow('Gemini API Error');
  });

  it('throws on MAX_TOKENS finish reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ));

    await expect(parseExpense('test', API_KEY)).rejects.toThrow('truncated');
  });

  it('throws on invalid JSON response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: 'not json' }] }, finishReason: 'STOP' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ));

    await expect(parseExpense('test', API_KEY)).rejects.toThrow();
  });

  it('throws on amount <= 0', async () => {
    const badExpense = { ...validExpense, amount: 0 };
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(createGeminiResponse(badExpense)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    await expect(parseExpense('test', API_KEY)).rejects.toThrow('Invalid amount');
  });

  it('throws on empty description', async () => {
    const badExpense = { ...validExpense, description: '' };
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(createGeminiResponse(badExpense)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    await expect(parseExpense('test', API_KEY)).rejects.toThrow('Missing description');
  });

  it('throws on missing category', async () => {
    const badExpense = { ...validExpense, category: '' };
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(createGeminiResponse(badExpense)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    await expect(parseExpense('test', API_KEY)).rejects.toThrow('Missing category');
  });

  it('includes dynamic prompts in request', async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify(createGeminiResponse(validExpense)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await parseExpense('test', API_KEY, undefined, {
      dynamicPrompts: ['Custom rule 1'],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    const promptText = body.contents[0].parts[0].text;
    expect(promptText).toContain('Custom rule 1');
  });
});
