import { expect, it, vi } from 'vitest';
import { transcribeAudio } from '../../src/ai/audio-transcription';
it('sends bounded audio through private OpenRouter routing and returns transcript only', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              text: 'Paid twenty dollars for lunch',
              relevance: 'financial'
            })
          },
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 }
    })
  );
  vi.stubGlobal('fetch', fetchMock);
  expect(
    await transcribeAudio({ data: 'UklGRg==', format: 'wav', language: 'en', apiKey: 'test' })
  ).toEqual({ text: 'Paid twenty dollars for lunch', relevance: 'financial' });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.provider).toMatchObject({ zdr: true, data_collection: 'deny' });
  expect(body.messages[1].content[1]).toMatchObject({
    type: 'input_audio',
    input_audio: { data: 'UklGRg==', format: 'wav' }
  });
  expect(body.tools).toBeUndefined();
  vi.unstubAllGlobals();
});
it('uses the stronger audio model and returns relevance without inventing missing fields', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              text: 'Transferí cincuenta mil a Nequi',
              relevance: 'financial'
            })
          },
          finish_reason: 'stop'
        }
      ]
    })
  );
  vi.stubGlobal('fetch', fetchMock);
  expect(
    await transcribeAudio({ data: 'UklGRg==', format: 'wav', language: 'es', apiKey: 'test' })
  ).toEqual({ text: 'Transferí cincuenta mil a Nequi', relevance: 'financial' });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.model).toBe('google/gemini-2.5-flash');
  expect(body.provider).toMatchObject({
    zdr: true,
    data_collection: 'deny',
    max_price: { prompt: 1, completion: 2.5 }
  });
  vi.unstubAllGlobals();
});
it('treats a spoken item and amount as financial shorthand without inventing a verb', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({ text: 'papas diez mil', relevance: 'financial' })
            },
            finish_reason: 'stop'
          }
        ]
      })
    );
  vi.stubGlobal('fetch', fetchMock);
  expect(
    await transcribeAudio({ data: 'UklGRg==', format: 'wav', language: 'es', apiKey: 'test' })
  ).toEqual({ text: 'papas diez mil', relevance: 'financial' });
  const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content;
  expect(prompt).toContain('papas diez mil');
  expect(prompt).toContain('item plus an amount');
  vi.unstubAllGlobals();
});
