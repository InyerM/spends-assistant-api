import type { DocumentImageType } from '../ai/vision';
import { DocumentOcrReservationError } from '../services/supabase/document-ocr.service';
import { CLOUD_PDF_MODEL, CloudPdfOcrError, extractCloudPdfDraft } from '../ai/cloud-pdf-ocr';
import { createSupabaseServices } from '../services/supabase';
import type { Env } from '../types/env';
import { resolveSupabaseJwtUserId, unauthorizedResponse } from '../utils/auth';
import { aiConsentErrorResponse } from '../utils/ai-consent-response';

const PAGE_RESERVATION_MICROS = 433527;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
async function equalSecret(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const hashes = await Promise.all(
    [left, right].map((value) => crypto.subtle.digest('SHA-256', encoder.encode(value)))
  );
  let difference = 0;
  const a = new Uint8Array(hashes[0]);
  const b = new Uint8Array(hashes[1]);
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function boundedBody(request: Request): Promise<string> {
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 8_000_000) {
        await reader.cancel();
        throw new CloudPdfOcrError('CLOUD_PDF_INVALID_INPUT', 413);
      }
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** Only the private authenticated web proxy can attest canonical single-page inspection. */
export async function handleDocumentPdfOcrExtract(request: Request, env: Env): Promise<Response> {
  const limit = Number(env.DOCUMENT_PDF_OCR_DAILY_BUDGET_USD);
  if (
    env.DOCUMENT_PDF_OCR_ENABLED !== 'true' ||
    !env.DOCUMENT_PDF_OCR_PROXY_SECRET ||
    !Number.isFinite(limit) ||
    limit <= 0 ||
    limit > 100
  )
    return Response.json({ code: 'CLOUD_PDF_DISABLED' }, { status: 503 });
  if (
    !(await equalSecret(
      request.headers.get('X-Document-OCR-Proxy-Secret') ?? '',
      env.DOCUMENT_PDF_OCR_PROXY_SECRET
    ))
  )
    return unauthorizedResponse();
  const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const userId = await resolveSupabaseJwtUserId(request, env);
  if (!userId) return unauthorizedResponse();
  let reservationId: string | undefined;
  let actualMicros = 0;
  let completeCost = true;
  try {
    const raw = await boundedBody(request);
    if (raw.length > 8_000_000)
      return Response.json({ code: 'CLOUD_PDF_INVALID_INPUT' }, { status: 413 });
    const body: unknown = JSON.parse(raw);
    if (
      !object(body) ||
      typeof body.documentId !== 'string' ||
      !UUID.test(body.documentId) ||
      typeof body.claimToken !== 'string' ||
      !UUID.test(body.claimToken) ||
      typeof body.sourceSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(body.sourceSha256) ||
      !Array.isArray(body.pages) ||
      body.pages.length < 1 ||
      body.pages.length > 5
    )
      return Response.json({ code: 'CLOUD_PDF_INVALID_INPUT' }, { status: 400 });
    const pages: { pageNumber: number; bytes: Uint8Array; sha256: string }[] = [];
    for (const [index, page] of body.pages.entries()) {
      if (
        !object(page) ||
        page.pageNumber !== index + 1 ||
        typeof page.pdfBase64 !== 'string' ||
        page.pdfBase64.length > 1_400_000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(page.pdfBase64) ||
        typeof page.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(page.sha256)
      )
        return Response.json({ code: 'CLOUD_PDF_INVALID_INPUT' }, { status: 400 });
      pages.push({
        pageNumber: index + 1,
        bytes: Uint8Array.from(atob(page.pdfBase64), (c) => c.charCodeAt(0)),
        sha256: page.sha256
      });
    }
    for (const page of pages) {
      const digest = await crypto.subtle.digest('SHA-256', page.bytes);
      const hash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('');
      if (
        page.bytes.length < 8 ||
        page.bytes.length > 1048576 ||
        new TextDecoder().decode(page.bytes.subarray(0, 5)) !== '%PDF-' ||
        hash !== page.sha256
      )
        return Response.json({ code: 'CLOUD_PDF_INVALID_INPUT' }, { status: 400 });
    }
    await services.aiConsent.require(userId, 'document_ocr');
    reservationId = await services.documentOcr.reserve(
      userId,
      body.documentId,
      body.claimToken,
      PAGE_RESERVATION_MICROS * pages.length,
      Math.floor(limit * 1e6)
    );
    const allowance = await services.usage.incrementAiParses(userId);
    if (!allowance.allowed) {
      await services.documentOcr.settle(reservationId, 0);
      reservationId = undefined;
      return Response.json({ code: 'PARSE_LIMIT_REACHED', ...allowance }, { status: 429 });
    }
    const observations = [];
    let documentType: DocumentImageType = 'statement';
    const deadline = Date.now() + 180_000;
    for (const page of pages) {
      if (Date.now() > deadline) throw new CloudPdfOcrError('CLOUD_PDF_UPSTREAM_FAILED');
      await services.aiConsent.require(userId, 'document_ocr');
      completeCost = false;
      const result = await services.aiUsage.track(
        { userId, operation: 'extract_document', model: CLOUD_PDF_MODEL },
        (meter) =>
          extractCloudPdfDraft({
            cloudPdfOptIn: true,
            apiKey: env.OPENROUTER_API_KEY,
            pdfBytes: page.bytes,
            trustedInspection: { sha256: page.sha256, pageCount: 1, encrypted: false },
            budgetRemainingUsd: PAGE_RESERVATION_MICROS / 1e6,
            meter,
            signal: AbortSignal.timeout(Math.min(60_000, Math.max(1, deadline - Date.now())))
          }),
        'document_ocr'
      );
      if (result.usage?.cost != null) {
        actualMicros += Math.ceil(result.usage.cost * 1e6);
        completeCost = true;
      } else actualMicros += PAGE_RESERVATION_MICROS;
      if (pages.length === 1) documentType = result.draft.document_type;
      observations.push(
        ...result.draft.observations.map((row) => ({ ...row, source_page: page.pageNumber }))
      );
    }
    await services.documentOcr.settle(reservationId, completeCost ? actualMicros : null);
    reservationId = undefined;
    return Response.json(
      {
        draft: { document_type: documentType, observations },
        pageCount: pages.length,
        model: CLOUD_PDF_MODEL,
        pathway: 'cloud-pdf-mistral-ocr',
        requiresReview: true,
        warnings: []
      },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (error) {
    const consent = aiConsentErrorResponse(error);
    if (consent) return consent;
    return Response.json(
      {
        code:
          error instanceof CloudPdfOcrError || error instanceof DocumentOcrReservationError
            ? error.code
            : 'CLOUD_PDF_REQUEST_FAILED'
      },
      {
        status:
          error instanceof DocumentOcrReservationError
            ? error.status
            : error instanceof SyntaxError
              ? 400
              : error instanceof CloudPdfOcrError && error.status === 413
                ? 413
                : 502
      }
    );
  } finally {
    if (reservationId) {
      try {
        await services.documentOcr.settle(reservationId, null);
      } catch {
        /* Reservation is retained conservatively. */
      }
    }
  }
}
