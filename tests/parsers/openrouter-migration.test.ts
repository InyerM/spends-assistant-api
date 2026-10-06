import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseExpense as parseExpenseWithConsent } from '../../src/parsers/expense';
import type { CacheService } from '../../src/services/cache.service';
import type { AiUsageService } from '../../src/services/supabase/ai-usage.service';
import { AiUsageMeter } from '../../src/ai/usage-meter';

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

const validExpense = {
  is_transaction: true,
  amount: 50000,
  description: 'Lunch',
  category: 'restaurant',
  bank: 'bancolombia',
  payment_type: 'debit',
  source: 'sms',
  confidence: 90
};

describe('expense parser OpenRouter migration', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('uses the selected model and preserves dynamic rules', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(validExpense) }, finish_reason: 'stop' }]
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await parseExpense('Compraste $50.000', 'key', undefined, {
      model: 'deepseek/deepseek-v4.1-flash',
      dynamicPrompts: ['Rule: restaurant']
    });

    expect(result.amount).toBe(50000);
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.model).toBe('deepseek/deepseek-v4.1-flash');
    expect(body.messages[0].content).toContain('Rule: restaurant');
    expect(body.messages[1].content).toContain('Compraste $50.000');
  });

  it('uses a model and prompt specific cache key', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(validExpense) }, finish_reason: 'stop' }]
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', fetchMock);
    const cache = {
      hashKey: vi.fn((value: string) => value),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn()
    } as unknown as CacheService;

    await parseExpense('Pago privado', 'key', cache, { model: 'model-a' });
    await parseExpense('Pago privado', 'key', cache, { model: 'model-b' });

    expect(cache.get).toHaveBeenCalledTimes(2);
    expect(vi.mocked(cache.get).mock.calls[0][0]).not.toEqual(
      vi.mocked(cache.get).mock.calls[1][0]
    );
  });

  it('does not write a bank message or model response to logs', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                { message: { content: JSON.stringify(validExpense) }, finish_reason: 'stop' }
              ]
            }),
            { status: 200 }
          )
      )
    );

    await parseExpense('Nequi secreto 12345', 'key');
    expect(JSON.stringify(spy.mock.calls)).not.toContain('Nequi secreto 12345');
    expect(JSON.stringify(spy.mock.calls)).not.toContain('Lunch');
  });
});

it('records OpenRouter text usage for a tracked parse without storing input text', async () => {
  const { ConsentGatedAiUsageService } = await import(
    '../../src/services/supabase/consent-gated-ai-usage.service'
  );
  const calls: Array<{ url: string; body?: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined });
      if (url.includes('openrouter.ai'))
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: JSON.stringify({ is_transaction: false }) },
                finish_reason: 'stop'
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.000002 }
          }),
          { status: 200 }
        );
      return new Response('[]', { status: 200 });
    })
  );
  await parseExpense('Private payment 12345', 'key', undefined, {
    model: 'example/model',
    telemetry: {
      userId: 'user-1',
      service: new ConsentGatedAiUsageService('https://db.test', 'key', {
        require: async () => undefined
      })
    }
  });
  const event = calls.find((call) => call.url.includes('ai_usage_events'));
  expect(event).toBeDefined();
  expect(JSON.parse(event!.body!)).toMatchObject({
    operation: 'parse_expense',
    model: 'example/model',
    billed_calls: 1,
    input_tokens: 10,
    output_tokens: 3,
    estimated_cost_micros: 2
  });
  expect(event!.body).not.toContain('Private payment');
});
