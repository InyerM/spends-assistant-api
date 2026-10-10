import { expect, it, vi } from 'vitest';
import { transcribeAudio } from '../../src/ai/audio-transcription';
it('sends bounded audio through private OpenRouter routing and returns transcript only', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      choices: [
        {
          message: { content: JSON.stringify({ text: 'Paid twenty dollars for lunch' }) },
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 }
    })
  );
  vi.stubGlobal('fetch', fetchMock);
  expect(
    await transcribeAudio({ data: 'UklGRg==', format: 'wav', language: 'en', apiKey: 'test' })
  ).toBe('Paid twenty dollars for lunch');
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.provider).toMatchObject({ zdr: true, data_collection: 'deny' });
  expect(body.messages[1].content[1]).toMatchObject({
    type: 'input_audio',
    input_audio: { data: 'UklGRg==', format: 'wav' }
  });
  expect(body.tools).toBeUndefined();
  vi.unstubAllGlobals();
});
