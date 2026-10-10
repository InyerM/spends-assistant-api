import { beforeEach, describe, expect, it, vi } from 'vitest';
import { completeJson } from '../../src/ai/openrouter';
import { AiUsageMeter } from '../../src/ai/usage-meter';

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
    expect(body.usage).toEqual({ include: true });
  });

  it.each([502, 503, 504])('recovers from transient upstream %s errors', async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('private', { status }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    expect(
      (
        await completeJson<{ ok: boolean }>({
          apiKey: 'key',
          model: 'model',
          system: 's',
          user: 'u'
        })
      ).data.ok
    ).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers from network failures and meters both attempts', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('private network details'))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{}' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const meter = new AiUsageMeter();
    await completeJson({ apiKey: 'key', model: 'model', system: 's', user: 'u', meter });
    expect(meter.summary().billedCalls).toBe(2);
  });

  it('recognizes upstream errors delivered inside a successful HTTP response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: { code: 503, message: 'private' } }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{}' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      completeJson({ apiKey: 'key', model: 'model', system: 's', user: 'u' })
    ).resolves.toMatchObject({ data: {} });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry authorization failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('private', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      completeJson({
        apiKey: 'key',
        model: 'model',
        system: 's',
        user: 'u',
        recoverMalformedOutput: true
      })
    ).rejects.toThrow('(401)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not start output recovery after the total deadline is exhausted', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = vi.fn(async () => {
      now = 45_000;
      return new Response('invalid');
    });
    vi.stubGlobal('fetch', fetchMock);
    const meter = new AiUsageMeter();
    await expect(
      completeJson({
        apiKey: 'key',
        model: 'model',
        system: 's',
        user: 'u',
        meter,
        recoverMalformedOutput: true
      })
    ).rejects.toMatchObject({ reason: 'invalid_json', stage: 'envelope' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(meter.summary().billedCalls).toBe(1);
  });

  it('bounds optional output capacity without changing the default', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })
      );
    vi.stubGlobal('fetch', fetchMock);
    for (const limit of [0, 8193, 128.5])
      await expect(
        completeJson({
          apiKey: 'key',
          model: 'model',
          system: 's',
          user: 'u',
          maxOutputTokens: limit
        })
      ).rejects.toThrow('Invalid output token limit');
    expect(fetchMock).not.toHaveBeenCalled();
    await completeJson({ apiKey: 'key', model: 'model', system: 's', user: 'u' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(2048);
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

  it.each(['envelope', 'content'] as const)(
    'recovers malformed %s JSON for email analysis',
    async (stage) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          stage === 'envelope'
            ? new Response('private malformed response')
            : Response.json({
                choices: [{ message: { content: 'private invalid JSON' } }],
                usage: { prompt_tokens: 10, completion_tokens: 5 }
              })
        )
        .mockResolvedValueOnce(
          Response.json({
            choices: [{ message: { content: '{"ok":true}' } }],
            usage: { prompt_tokens: 10, completion_tokens: 3 }
          })
        );
      vi.stubGlobal('fetch', fetchMock);
      const meter = new AiUsageMeter();
      await expect(
        completeJson({
          apiKey: 'key',
          model: 'model',
          system: 's',
          user: 'u',
          meter,
          recoverMalformedOutput: true
        })
      ).resolves.toMatchObject({ data: { ok: true } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(meter.summary()).toMatchObject({
        billedCalls: 2,
        outputTokens: stage === 'envelope' ? 3 : 8
      });
    }
  );

  it('retries truncated email output with bounded extra capacity and meters discarded output', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ message: { content: '{"ok":' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 10, completion_tokens: 2048 }
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 15 }
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const meter = new AiUsageMeter();
    await expect(
      completeJson({
        apiKey: 'key',
        model: 'model',
        system: 's',
        user: 'u',
        meter,
        recoverMalformedOutput: true
      })
    ).resolves.toMatchObject({ data: { ok: true } });
    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).max_tokens)).toEqual([
      2048, 4096
    ]);
    expect(meter.summary()).toMatchObject({ billedCalls: 2, outputTokens: 2063 });
  });

  it.each(['envelope', 'content'] as const)(
    'bounds persistent malformed %s failures and reports their stage without private content',
    async (stage) => {
      const fetchMock = vi
        .fn()
        .mockImplementation(async () =>
          stage === 'envelope'
            ? new Response('private malformed response')
            : Response.json({ choices: [{ message: { content: 'private invalid JSON' } }] })
        );
      vi.stubGlobal('fetch', fetchMock);
      const meter = new AiUsageMeter();
      await expect(
        completeJson({
          apiKey: 'key',
          model: 'model',
          system: 's',
          user: 'private user',
          meter,
          recoverMalformedOutput: true
        })
      ).rejects.toMatchObject({
        reason: 'invalid_json',
        stage,
        message: 'OpenRouter returned invalid JSON'
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(meter.summary().billedCalls).toBe(3);
    }
  );

  it('does not retry malformed output without opting in', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('invalid'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      completeJson({ apiKey: 'key', model: 'model', system: 's', user: 'u' })
    ).rejects.toMatchObject({ reason: 'invalid_json', stage: 'envelope' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caps recovered output at 8192 tokens and limits persistent truncation to three attempts', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }] })
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      completeJson({
        apiKey: 'key',
        model: 'model',
        system: 's',
        user: 'u',
        maxOutputTokens: 8192,
        recoverMalformedOutput: true
      })
    ).rejects.toMatchObject({ reason: 'truncated', stage: 'content' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).max_tokens)).toEqual([
      8192, 8192, 8192
    ]);
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

  it('meters each upstream text attempt without retaining content', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 8, completion_tokens: 2, cost: 0.000004 }
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetchMock);
    const meter = new AiUsageMeter();
    await completeJson({
      apiKey: 'key',
      model: 'model',
      system: 'secret system',
      user: 'secret user',
      meter
    });
    expect(meter.summary()).toEqual({
      billedCalls: 2,
      inputTokens: 8,
      outputTokens: 2,
      estimatedCostMicros: 4,
      costSource: 'partial'
    });
    expect(JSON.stringify(meter)).not.toContain('secret');
  });

  it('meters a failed upstream call as unknown cost', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('private', { status: 500 }))
    );
    const meter = new AiUsageMeter();
    await expect(
      completeJson({ apiKey: 'key', model: 'model', system: 's', user: 'u', meter })
    ).rejects.toThrow('OpenRouter request failed (500)');
    expect(meter.summary()).toMatchObject({ billedCalls: 3, costSource: 'unknown' });
  });
});

it('bounds public merchant search, disables unnecessary reasoning and retains upstream citations', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      choices: [
        {
          message: {
            content: '{"ok":true}',
            annotations: [
              { type: 'url_citation', url_citation: { url: 'https://example.com/about' } }
            ]
          }
        }
      ],
      usage: { prompt_tokens: 100, completion_tokens: 40, cost: 0.005 }
    })
  );
  vi.stubGlobal('fetch', fetchMock);
  const result = await completeJson({
    apiKey: 'key',
    model: 'model',
    system: 'Public merchant',
    user: '{"merchant":"PUBLIC STORE"}',
    publicWebSearch: true,
    disableReasoning: true,
    timeoutMs: 10000
  });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.tools).toEqual([
    {
      type: 'openrouter:web_search',
      parameters: {
        engine: 'exa',
        max_results: 3,
        max_total_results: 3,
        max_uses: 1,
        search_context_size: 'low'
      }
    }
  ]);
  expect(body.reasoning).toEqual({ enabled: false });
  expect(body.provider.zdr).toBe(true);
  expect(result.citations).toEqual(['https://example.com/about']);
});
