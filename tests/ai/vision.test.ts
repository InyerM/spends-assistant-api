import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractImageObservations } from '../../src/ai/vision';

const imageDataUrl = 'data:image/png;base64,aGVsbG8=';

function response(content: unknown, finishReason = 'stop'): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) }, finish_reason: finishReason }],
      usage: { prompt_tokens: 2000, completion_tokens: 300, cost: 0.000416 }
    }),
    { status: 200 }
  );
}

const extracted = {
  document_type: 'receipt',
  observations: [
    {
      amount: 12000,
      currency: 'COP',
      occurred_at: '2026-09-28T12:00:00-05:00',
      description: 'Lunch',
      counterparty: 'Cafe',
      reference: null,
      source_excerpt: 'TOTAL 12.000',
      confidence: 0.94
    },
    {
      amount: 5000,
      currency: 'COP',
      occurred_at: '2026-09-28T13:00:00-05:00',
      description: 'Coffee',
      counterparty: 'Cafe',
      reference: null,
      source_excerpt: 'TOTAL 5.000',
      confidence: 0.89
    }
  ]
};

describe('extractImageObservations', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses Qwen3 VL 30B with private routing and returns multiple draft observations', async () => {
    const fetchMock = vi.fn(async () => response(extracted));
    vi.stubGlobal('fetch', fetchMock);

    const result = await extractImageObservations({ apiKey: 'key', imageDataUrl });

    expect(result.model).toBe('qwen/qwen3-vl-30b-a3b-instruct');
    expect(result.draft.observations).toHaveLength(2);
    expect(result.usage).toEqual({ prompt_tokens: 2000, completion_tokens: 300, cost: 0.000416 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('qwen/qwen3-vl-30b-a3b-instruct');
    expect(body.provider).toMatchObject({ zdr: true, data_collection: 'deny' });
    expect(body.usage).toEqual({ include: true });
    expect(body.response_format.type).toBe('json_schema');
    expect(body.messages[1].content).toContainEqual({
      type: 'image_url',
      image_url: { url: imageDataUrl }
    });
  });

  it('uses the larger model only on explicit escalation', async () => {
    const fetchMock = vi.fn(async () => response(extracted));
    vi.stubGlobal('fetch', fetchMock);

    const result = await extractImageObservations({
      apiKey: 'key',
      imageDataUrl,
      escalate: true
    });

    expect(result.model).toBe('qwen/qwen3-vl-235b-a22b-instruct');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(result.model);
  });

  it('rejects unsupported or oversized input before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      extractImageObservations({ apiKey: 'key', imageDataUrl: 'data:text/plain;base64,aGVsbG8=' })
    ).rejects.toThrow('Unsupported image data');
    await expect(
      extractImageObservations({
        apiKey: 'key',
        imageDataUrl: `data:image/png;base64,${'a'.repeat(11_000_000)}`
      })
    ).rejects.toThrow('Image too large');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed or truncated output without exposing private image content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(extracted, 'length'))
    );
    await expect(extractImageObservations({ apiKey: 'key', imageDataUrl })).rejects.toThrow(
      'Vision response truncated'
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ document_type: 'receipt' }))
    );
    await expect(extractImageObservations({ apiKey: 'key', imageDataUrl })).rejects.toThrow(
      'Invalid vision response'
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('private image text', { status: 500 }))
    );
    await expect(extractImageObservations({ apiKey: 'key', imageDataUrl })).rejects.toThrow(
      'Vision request failed (500)'
    );
  });
});
