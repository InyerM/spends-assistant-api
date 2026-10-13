import { beforeEach, expect, it, vi } from 'vitest';
import { handleAudioTranscribe } from '../../src/handlers/audio-transcribe';
import { createMockEnv } from '../__test-helpers__/factories';
import { AiConsentRequiredError } from '../../src/services/supabase/ai-consent.service';
const mocks = vi.hoisted(() => ({
  consent: vi.fn(),
  quota: vi.fn(),
  track: vi.fn(),
  transcribe: vi.fn(),
  session: vi.fn()
}));
vi.mock('../../src/services/supabase', () => ({
  createSupabaseServices: () => ({
    apiKeys: {},
    aiConsent: { require: mocks.consent },
    usage: { incrementAiParses: mocks.quota, reserveAudioTranscription: mocks.session },
    aiUsage: { track: mocks.track }
  })
}));
vi.mock('../../src/utils/auth', () => ({
  resolveUserId: async (request: Request) =>
    request.headers.has('Authorization') ? 'owner' : null,
  unauthorizedResponse: () => Response.json({}, { status: 401 })
}));
vi.mock('../../src/ai/audio-transcription', () => ({
  AUDIO_MODEL: 'test-model',
  transcribeAudio: mocks.transcribe
}));
const request = (body: unknown, auth = true): Request =>
  new Request('http://localhost/audio/transcribe', {
    method: 'POST',
    headers: auth ? { Authorization: 'Bearer valid' } : {},
    body: JSON.stringify(body)
  });
const valid = { data: 'UklGRg==', format: 'wav', language: 'es' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.consent.mockResolvedValue(undefined);
  mocks.quota.mockResolvedValue({ allowed: true });
  mocks.track.mockImplementation((_meta, callback) => callback({ record: vi.fn() }));
  mocks.transcribe.mockResolvedValue({ text: 'A spoken transaction', relevance: 'financial' });
});
it('authenticates, checks consent and quota and only returns a transient transcript', async () => {
  expect((await handleAudioTranscribe(request(valid, false), createMockEnv())).status).toBe(401);
  expect(mocks.quota).not.toHaveBeenCalled();
  const response = await handleAudioTranscribe(request(valid), createMockEnv());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: 'A spoken transaction', relevance: 'financial' });
  expect(mocks.consent).toHaveBeenCalledWith('owner', 'financial_text');
  expect(mocks.track).toHaveBeenCalledWith(
    expect.objectContaining({ operation: 'parse_expense' }),
    expect.any(Function)
  );
  expect(response.headers.get('Cache-Control')).toContain('no-store');
});
it('rejects unsupported media, exhausted quota and revoked consent before calling AI', async () => {
  expect(
    (await handleAudioTranscribe(request({ ...valid, format: 'html' }), createMockEnv())).status
  ).toBe(400);
  mocks.consent.mockRejectedValueOnce(new AiConsentRequiredError('financial_text'));
  expect((await handleAudioTranscribe(request(valid), createMockEnv())).status).toBe(428);
  mocks.quota.mockResolvedValueOnce({ allowed: false });
  expect((await handleAudioTranscribe(request(valid), createMockEnv())).status).toBe(429);
  expect(mocks.transcribe).not.toHaveBeenCalled();
});

it('reserves session quota using the authenticated owner and rejects unbounded sequence numbers', async () => {
  const session = { session_id: '12345678-1234-4321-8123-123456789abc', sequence: 0, final: false };
  mocks.session.mockResolvedValue({ allowed: true, used: 1, limit: 15 });
  expect(
    (await handleAudioTranscribe(request({ ...valid, ...session }), createMockEnv())).status
  ).toBe(200);
  expect(mocks.session).toHaveBeenCalledWith('owner', session.session_id, 0, false);
  expect(mocks.quota).not.toHaveBeenCalled();
  expect(
    (await handleAudioTranscribe(request({ ...valid, ...session, sequence: 4 }), createMockEnv()))
      .status
  ).toBe(400);
});
