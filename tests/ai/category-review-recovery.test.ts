import { afterEach, expect, it, vi } from 'vitest';
import { reviewCategory } from '../../src/ai/category-review';
import { AiUsageMeter } from '../../src/ai/usage-meter';

const input = {
  locale: 'es' as const,
  type: 'expense' as const,
  description: 'Lunch',
  history: []
};
const proposal = {
  category_id: null,
  description: 'Lunch',
  notes: '',
  explanation: 'The purpose needs confirmation.',
  kind: 'expense',
  evidence_ids: []
};

afterEach(() => vi.unstubAllGlobals());

it.each(['length', 'stop'])(
  'recovers an incomplete category proposal with finish reason %s before returning suggestions',
  async (finishReason) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ message: { content: '{"description":' }, finish_reason: finishReason }],
          usage: { prompt_tokens: 20, completion_tokens: 1100 }
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ message: { content: JSON.stringify(proposal) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 70 }
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const meter = new AiUsageMeter();

    await expect(reviewCategory(input, [], 'key', 'model', meter)).resolves.toEqual(proposal);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const limits = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).max_tokens);
    expect(limits[1]).toBe(finishReason === 'length' ? limits[0] * 2 : limits[0]);
    expect(meter.summary()).toMatchObject({ billedCalls: 2, outputTokens: 1170 });
  }
);

it('bounds repeated truncation and never returns a partial suggestion', async () => {
  const fetchMock = vi.fn().mockImplementation(async () =>
    Response.json({
      choices: [{ message: { content: JSON.stringify(proposal) }, finish_reason: 'length' }]
    })
  );
  vi.stubGlobal('fetch', fetchMock);
  await expect(reviewCategory(input, [], 'key', 'model')).rejects.toMatchObject({
    reason: 'truncated',
    stage: 'content'
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
