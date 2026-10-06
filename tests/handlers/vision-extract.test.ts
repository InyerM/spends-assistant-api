import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleVisionExtract } from '../../src/handlers/vision-extract';
import { extractImageObservations } from '../../src/ai/vision';
import { createMockEnv } from '../__test-helpers__/factories';
import { AiConsentRequiredError } from '../../src/services/supabase/ai-consent.service';

const trackUsage = vi.hoisted(() => vi.fn());
const incrementAiParses = vi.hoisted(() => vi.fn());
const requireConsent = vi.hoisted(() => vi.fn());
vi.mock('../../src/ai/vision', () => ({
  DEFAULT_VISION_MODEL: 'qwen/qwen3-vl-30b-a3b-instruct',
  extractImageObservations: vi.fn()
}));
vi.mock('../../src/services/supabase', () => ({
  createSupabaseServices: () => ({
    apiKeys: {},
    aiUsage: { track: trackUsage },
    aiConsent: { require: requireConsent },
    usage: { incrementAiParses }
  })
}));
vi.mock('../../src/utils/auth', () => ({
  resolveUserId: vi.fn(async (request: Request) =>
    request.headers.get('Authorization') === 'Bearer valid' ? 'user-1' : null
  ),
  unauthorizedResponse: () =>
    new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
}));

const env = createMockEnv();
const imageDataUrl = 'data:image/png;base64,aGVsbG8=';

function request(body: unknown, token = 'valid'): Request {
  return new Request('http://localhost/vision/extract', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

describe('handleVisionExtract', () => {
  afterEach(() => vi.clearAllMocks());

  beforeEach(() => {
    trackUsage.mockImplementation(async (_params, fn) => fn({ record: vi.fn() }));
    requireConsent.mockResolvedValue(undefined);
    incrementAiParses.mockResolvedValue({ allowed: true, used: 1, limit: 15 });
  });

  it('does not consume the AI request count when image consent is missing', async () => {
    requireConsent.mockRejectedValueOnce(new AiConsentRequiredError('document_images'));
    const response = await handleVisionExtract(request({ image_data_url: imageDataUrl }), env);
    expect(response.status).toBe(428);
    expect(incrementAiParses).not.toHaveBeenCalled();
    expect(trackUsage).not.toHaveBeenCalled();
  });

  it('returns consent-required without invoking vision extraction', async () => {
    trackUsage.mockRejectedValueOnce(new AiConsentRequiredError('document_images'));
    const response = await handleVisionExtract(request({ image_data_url: imageDataUrl }), env);
    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({
      code: 'AI_CONSENT_REQUIRED',
      scope: 'document_images'
    });
    expect(extractImageObservations).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request before invoking the model', async () => {
    const response = await handleVisionExtract(
      request({ image_data_url: imageDataUrl }, 'wrong'),
      env
    );
    expect(response.status).toBe(401);
    expect(extractImageObservations).not.toHaveBeenCalled();
  });

  it('returns a review draft with distinct observations and no saved transactions', async () => {
    vi.mocked(extractImageObservations).mockResolvedValue({
      model: 'qwen/qwen3-vl-30b-a3b-instruct',
      draft: {
        document_type: 'receipt',
        observations: [
          {
            amount: 12000,
            currency: 'COP',
            occurred_at: null,
            description: 'Lunch',
            counterparty: null,
            reference: null,
            source_excerpt: '12.000',
            confidence: 0.9
          },
          {
            amount: 5000,
            currency: 'COP',
            occurred_at: null,
            description: 'Coffee',
            counterparty: null,
            reference: null,
            source_excerpt: '5.000',
            confidence: 0.8
          }
        ]
      },
      usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 }
    });

    const response = await handleVisionExtract(request({ image_data_url: imageDataUrl }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      draft: { document_type: 'receipt', observations: [{ amount: 12000 }, { amount: 5000 }] },
      model: 'qwen/qwen3-vl-30b-a3b-instruct'
    });
    expect(extractImageObservations).toHaveBeenCalledWith({
      apiKey: env.OPENROUTER_API_KEY,
      imageDataUrl,
      escalate: false,
      meter: expect.anything()
    });
    expect(trackUsage).toHaveBeenCalledWith(
      {
        userId: 'user-1',
        operation: 'extract_document',
        model: 'qwen/qwen3-vl-30b-a3b-instruct'
      },
      expect.any(Function)
    );
  });

  it('rejects missing image input without invoking the model', async () => {
    const response = await handleVisionExtract(request({}), env);
    expect(response.status).toBe(400);
    expect(extractImageObservations).not.toHaveBeenCalled();
    expect(incrementAiParses).not.toHaveBeenCalled();
  });

  it('uses the existing AI request quota and skips the model when it is exhausted', async () => {
    incrementAiParses.mockResolvedValue({ allowed: false, used: 15, limit: 15 });

    const response = await handleVisionExtract(request({ image_data_url: imageDataUrl }), env);

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: 'Parse limit reached',
      code: 'PARSE_LIMIT_REACHED',
      used: 15,
      limit: 15
    });
    expect(incrementAiParses).toHaveBeenCalledWith('user-1');
    expect(trackUsage).not.toHaveBeenCalled();
    expect(extractImageObservations).not.toHaveBeenCalled();
  });

  it('keeps provider errors and image data out of the response', async () => {
    vi.mocked(extractImageObservations).mockRejectedValue(new Error(`private ${imageDataUrl}`));
    const response = await handleVisionExtract(request({ image_data_url: imageDataUrl }), env);
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain('Vision extraction failed');
    expect(body).not.toContain('private');
    expect(body).not.toContain(imageDataUrl);
  });
});
