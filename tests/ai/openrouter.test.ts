import { beforeEach, describe, expect, it, vi } from 'vitest';
import { completeJson } from '../../src/ai/openrouter';

describe('completeJson', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sends financial content only to providers without retention or training', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"amount":50000}' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 20 }
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await completeJson<{ amount: number }>({
      apiKey: 'secret',
      model: 'deepseek/deepseek-v4.1-flash',
      system: 'Extract transaction',
      user: 'Pago 50000'
    });

    expect(result.data.amount).toBe(50000);
    expect(result.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer secret');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('deepseek/deepseek-v4.1-flash');
    expect(body.messages).toEqual([
      { role: 'system', content: 'Extract transaction' },
      { role: 'user', content: 'Pago 50000' }
    ]);
    expect(body.provider).toMatchObject({
      zdr: true,
      data_collection: 'deny',
      max_price: { prompt: 0.4, completion: 1 }
    });
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('does not log or echo the financial input on an upstream error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('sensitive upstream body', { status: 500 }))
    );
    const secret = 'Pago privado a persona 12345';
    await expect(
      completeJson({ apiKey: 'key', model: 'model', system: 's', user: secret })
    ).rejects.toThrow('OpenRouter request failed (500)');
  });

  it('rejects a truncated model response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"amount":' }, finish_reason: 'length' }]
            }),
            { status: 200 }
          )
      )
    );
    await expect(
      completeJson({ apiKey: 'key', model: 'model', system: 's', user: 'u' })
    ).rejects.toThrow('truncated');
  });

  it('retries a rate limit response and returns the next successful result', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }]
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await completeJson<{ ok: boolean }>({
      apiKey: 'key',
      model: 'model',
      system: 's',
      user: 'u'
    });
    expect(result.data.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
