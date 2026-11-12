import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleDocumentPdfOcrExtract } from '../../src/handlers/document-pdf-ocr-extract';
import type { Env } from '../../src/types/env';

describe('cloud PDF route dispatch gates', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('remains disabled without explicit configuration', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const response = await handleDocumentPdfOcrExtract(
      new Request('https://worker/documents/extract-pdf-ocr', { method: 'POST' }),
      {} as Env
    );
    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects browser-supplied inspection without the private proxy credential', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const response = await handleDocumentPdfOcrExtract(
      new Request('https://worker/documents/extract-pdf-ocr', { method: 'POST' }),
      {
        DOCUMENT_PDF_OCR_ENABLED: 'true',
        DOCUMENT_PDF_OCR_PROXY_SECRET: 'private',
        DOCUMENT_PDF_OCR_DAILY_BUDGET_USD: '1'
      } as Env
    );
    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
});

const bytes = new TextEncoder().encode('%PDF-1.4 synthetic');
const page = {
  pageNumber: 1,
  pdfBase64: Buffer.from(bytes).toString('base64'),
  sha256: createHash('sha256').update(bytes).digest('hex')
};
const payload = {
  documentId: '11111111-1111-1111-1111-111111111111',
  claimToken: '22222222-2222-2222-2222-222222222222',
  sourceSha256: page.sha256,
  pages: [page]
};
const env = {
  SUPABASE_URL: 'https://db',
  SUPABASE_SERVICE_KEY: 'service',
  API_KEY: 'test',
  DEFAULT_USER_ID: 'owner',
  OPENROUTER_API_KEY: 'or',
  DOCUMENT_PDF_OCR_ENABLED: 'true',
  DOCUMENT_PDF_OCR_PROXY_SECRET: 'private',
  DOCUMENT_PDF_OCR_DAILY_BUDGET_USD: '5'
} as Env;
function request(body: unknown = payload) {
  return new Request('https://worker/documents/extract-pdf-ocr', {
    method: 'POST',
    headers: { Authorization: 'Bearer jwt', 'X-Document-OCR-Proxy-Secret': 'private' },
    body: JSON.stringify(body)
  });
}
function setup(consent = true, fail = false, documentType = 'statement') {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.includes('/auth/v1/user')) return Response.json({ id: 'owner' });
    if (url.includes('api_keys')) return Response.json([]);
    if (url.includes('ai_consent_decisions'))
      return Response.json(
        consent
          ? [
              {
                scope: 'document_ocr',
                version: 'external-ai-v1',
                granted_at: '2026-11-12',
                revoked_at: null
              }
            ]
          : []
      );
    if (url.includes('reserve_document_ocr_budget')) return Response.json('reservation');
    if (url.includes('settle_document_ocr_budget')) return Response.json(true);
    if (url.includes('reserve_ai_parse'))
      return Response.json([{ allowed: true, used: 1, limit: 15 }]);
    if (url.includes('openrouter'))
      return fail
        ? new Response('', { status: 503 })
        : Response.json({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({ document_type: documentType, observations: [] })
                }
              }
            ],
            usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0.002 }
          });
    if (url.includes('usage')) return Response.json({ allowed: true });
    throw new Error('Unexpected mock URL ' + url + ' ' + init?.method);
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, calls };
}
it('checks OCR consent before reservation and paid dispatch', async () => {
  const { calls } = setup(false);
  const response = await handleDocumentPdfOcrExtract(request(), env);
  expect(response.status).toBe(428);
  expect(calls.some((url) => url.includes('openrouter'))).toBe(false);
  expect(calls.some((url) => url.includes('reserve_document'))).toBe(false);
});
it('reserves before dispatch and returns only all-page review drafts', async () => {
  const { fetch, calls } = setup();
  const response = await handleDocumentPdfOcrExtract(request(), env);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    draft: { document_type: 'statement', observations: [] },
    requiresReview: true,
    pageCount: 1
  });
  expect(calls.findIndex((url) => url.includes('reserve_document'))).toBeLessThan(
    calls.findIndex((url) => url.includes('openrouter'))
  );
  const settlement = fetch.mock.calls.find(([url]) => url.includes('settle_document'));
  expect(JSON.parse(settlement![1]!.body as string).p_actual_micros).toBe(2000);
});
it('retains the full reservation on an uncertain failed paid request', async () => {
  const { fetch } = setup(true, true);
  const response = await handleDocumentPdfOcrExtract(request(), env);
  expect(response.status).toBe(502);
  const settlement = fetch.mock.calls.find(([url]) => url.includes('settle_document'));
  expect(JSON.parse(settlement![1]!.body as string).p_actual_micros).toBeNull();
});
it('rejects noncontiguous page provenance before consent or dispatch', async () => {
  const { calls } = setup();
  const response = await handleDocumentPdfOcrExtract(
    request({ ...payload, pages: [{ ...page, pageNumber: 2 }] }),
    env
  );
  expect(response.status).toBe(400);
  expect(calls.some((url) => url.includes('openrouter'))).toBe(false);
});

it('validates every page hash before reserving or calling any provider', async () => {
  const { calls } = setup();
  const response = await handleDocumentPdfOcrExtract(
    request({ ...payload, pages: [page, { ...page, pageNumber: 2, sha256: '0'.repeat(64) }] }),
    env
  );
  expect(response.status).toBe(400);
  expect(calls.some((url) => url.includes('reserve_document') || url.includes('openrouter'))).toBe(
    false
  );
});
it('completes every page while charging one user parse action', async () => {
  const { calls } = setup();
  const response = await handleDocumentPdfOcrExtract(
    request({ ...payload, pages: [page, { ...page, pageNumber: 2 }] }),
    env
  );
  expect(response.status).toBe(200);
  expect((await response.json()).pageCount).toBe(2);
  expect(calls.filter((url) => url.includes('openrouter'))).toHaveLength(2);
  expect(calls.filter((url) => url.includes('reserve_ai_parse'))).toHaveLength(1);
});
it('rejects legacy delegated API credentials even with proxy authentication', async () => {
  const { calls } = setup();
  const req = request();
  req.headers.set('Authorization', 'Bearer test');
  expect((await handleDocumentPdfOcrExtract(req, env)).status).toBe(401);
  expect(calls).toEqual([]);
});

it('preserves the source document type for a single canonical page', async () => {
  setup(true, false, 'receipt');
  const response = await handleDocumentPdfOcrExtract(request(), env);
  expect(response.status).toBe(200);
  expect((await response.json()).draft.document_type).toBe('receipt');
});
it('aggregates multiple canonical pages as a statement', async () => {
  setup(true, false, 'receipt');
  const response = await handleDocumentPdfOcrExtract(
    request({ ...payload, pages: [page, { ...page, pageNumber: 2 }] }),
    env
  );
  expect(response.status).toBe(200);
  expect((await response.json()).draft.document_type).toBe('statement');
});
