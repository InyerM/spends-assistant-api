import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { extractCloudPdfDraft } from '../../src/ai/cloud-pdf-ocr';
const pdfBytes = new TextEncoder().encode('%PDF-1.4\nsynthetic fixture');
const inspection = {
  sha256: createHash('sha256').update(pdfBytes).digest('hex'),
  pageCount: 3,
  encrypted: false as const
};
const input = {
  cloudPdfOptIn: true,
  apiKey: 'test-key',
  pdfBytes,
  trustedInspection: inspection,
  budgetRemainingUsd: 1
};
const observation = {
  amount: -12.5,
  printed_amount: '12,50',
  direction: 'outgoing',
  currency: 'COP',
  occurred_at: '2026-11-01',
  description: 'Synthetic purchase',
  counterparty: null,
  reference: null,
  source_excerpt: '01/11/2026 PURCHASE COP 12,50',
  confidence: 0.8
};
const draft = { document_type: 'statement', observations: [observation] };
it.each([
  { amount: 12.5, direction: 'outgoing' },
  { amount: -12.5, direction: 'incoming' }
])('rejects a contradictory cash-flow sign for $direction', async (change) => {
  mockReply({ ...draft, observations: [{ ...observation, ...change }] });
  await expect(extractCloudPdfDraft(input)).rejects.toMatchObject({
    code: 'CLOUD_PDF_INVALID_OUTPUT'
  });
});
function mockReply(content: unknown = draft, wrapped = false) {
  const text = JSON.stringify(content);
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      choices: [
        {
          message: { content: wrapped ? '```json\n' + text + '\n```' : text },
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 100, completion_tokens: 100, cost: 0.0061 }
    })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
afterEach(() => vi.unstubAllGlobals());
it('is disabled without explicit cloud PDF opt-in before any external call', async () => {
  const fetchMock = mockReply();
  await expect(extractCloudPdfDraft({ ...input, cloudPdfOptIn: false })).rejects.toMatchObject({
    code: 'CLOUD_PDF_DISABLED'
  });
  expect(fetchMock).not.toHaveBeenCalled();
});
it('reserves pages and tokens before dispatch and binds inspection to the exact bytes', async () => {
  const fetchMock = mockReply();
  for (const change of [
    { budgetRemainingUsd: 0.001 },
    { trustedInspection: { ...inspection, pageCount: 6 } },
    { trustedInspection: { ...inspection, sha256: '0'.repeat(64) } },
    { trustedInspection: { ...inspection, encrypted: true } }
  ])
    await expect(extractCloudPdfDraft({ ...input, ...change })).rejects.toBeDefined();
  expect(fetchMock).not.toHaveBeenCalled();
});
it('sends one fixed OCR engine/model with privacy restrictions and returns review-only draft', async () => {
  const fetchMock = mockReply();
  const result = await extractCloudPdfDraft(input);
  const request = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(request.model).toBe('deepseek/deepseek-v4.1-flash');
  expect(request.plugins).toEqual([{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }]);
  expect(request.provider).toMatchObject({ zdr: true, data_collection: 'deny' });
  expect(request.models).toBeUndefined();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    draft,
    requiresReview: true,
    strictJson: true,
    usage: { cost: 0.0061 }
  });
});
it('accepts only complete enclosing fences and validates the full schema after normalization', async () => {
  mockReply(draft, true);
  expect((await extractCloudPdfDraft(input)).strictJson).toBe(false);
  for (const changed of [
    { ...draft, extra: true },
    { ...draft, observations: [{ ...observation, confidence: 1.1 }] },
    { ...draft, observations: [{ ...observation, amount: '12' }] },
    { ...draft, observations: [{ ...observation, occurred_at: '2026-02-30' }] },
    { ...draft, observations: [{ ...observation, currency: 'pesos' }] }
  ]) {
    mockReply(changed);
    await expect(extractCloudPdfDraft(input)).rejects.toMatchObject({
      code: 'CLOUD_PDF_INVALID_OUTPUT'
    });
  }
});
it('keeps empty and uncertain drafts in review without triggering any fallback', async () => {
  for (const observations of [
    [],
    [
      {
        ...observation,
        amount: null,
        printed_amount: null,
        direction: 'unknown',
        currency: null,
        occurred_at: null,
        confidence: 0
      }
    ]
  ]) {
    const fetchMock = mockReply({ document_type: 'statement', observations });
    expect((await extractCloudPdfDraft(input)).requiresReview).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }
});
it('sanitizes upstream failures and never retries', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response('private raw PDF text', { status: 503 }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(extractCloudPdfDraft(input)).rejects.toMatchObject({
    message: 'Cloud PDF OCR request failed',
    code: 'CLOUD_PDF_UPSTREAM_FAILED',
    status: 503
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('rejects non-string direction and unsupported observation keys', async () => {
  for (const row of [
    { ...observation, direction: ['outgoing'] },
    { ...observation, extra: true }
  ]) {
    mockReply({ document_type: 'statement', observations: [row] });
    await expect(extractCloudPdfDraft(input)).rejects.toMatchObject({
      code: 'CLOUD_PDF_INVALID_OUTPUT'
    });
  }
});

it('rejects malformed fences, truncation and excessive observations without recovery calls', async () => {
  for (const content of ['```json\n' + JSON.stringify(draft), 'prefix ' + JSON.stringify(draft)]) {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] })
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(extractCloudPdfDraft(input)).rejects.toMatchObject({
      code: 'CLOUD_PDF_INVALID_OUTPUT'
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }
  mockReply({ ...draft, observations: Array.from({ length: 151 }, () => observation) });
  await expect(extractCloudPdfDraft(input)).rejects.toMatchObject({
    code: 'CLOUD_PDF_INVALID_OUTPUT'
  });
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      choices: [{ message: { content: JSON.stringify(draft) }, finish_reason: 'length' }]
    })
  );
  vi.stubGlobal('fetch', fetchMock);
  await expect(extractCloudPdfDraft(input)).rejects.toMatchObject({
    code: 'CLOUD_PDF_INVALID_OUTPUT'
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('cancels an oversized upstream stream before retaining its full content', async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(256001));
    },
    cancel
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));
  await expect(extractCloudPdfDraft(input)).rejects.toMatchObject({
    code: 'CLOUD_PDF_INVALID_OUTPUT'
  });
  expect(cancel).toHaveBeenCalled();
});

it('records total reported cost once even when the response draft is invalid', async () => {
  const meter = { record: vi.fn() } as unknown as import('../../src/ai/usage-meter').AiUsageMeter;
  mockReply({ ...draft, extra: true });
  await expect(extractCloudPdfDraft({ ...input, meter })).rejects.toMatchObject({
    code: 'CLOUD_PDF_INVALID_OUTPUT'
  });
  expect(meter.record).toHaveBeenCalledExactlyOnceWith({
    inputTokens: 100,
    outputTokens: 100,
    costUsd: 0.0061
  });
});
it.each(['receipt', 'bank_screenshot', 'sms_screenshot', 'statement', 'other'])(
  'accepts the existing %s document type as review-only evidence',
  async (document_type) => {
    mockReply({ ...draft, document_type });
    expect((await extractCloudPdfDraft(input)).draft.document_type).toBe(document_type);
  }
);
it('rejects document types outside the existing allowlist', async () => {
  mockReply({ ...draft, document_type: 'invoice-posted' });
  await expect(extractCloudPdfDraft(input)).rejects.toMatchObject({
    code: 'CLOUD_PDF_INVALID_OUTPUT'
  });
});
