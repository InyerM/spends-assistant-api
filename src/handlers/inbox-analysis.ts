import { createSupabaseServices } from '../services/supabase';
import { dispatchInboxAnalysis, processInboxAnalysisLease } from '../services/inbox-analysis';
import type { Env } from '../types/env';
import type { InboxAnalysisResult } from '../types/inbox-analysis';
import { resolveUserId, unauthorizedResponse } from '../utils/auth';
import { aiConsentErrorResponse } from '../utils/ai-consent-response';
import { AiConsentRequiredError } from '../services/supabase/ai-consent.service';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const privateHeaders = { 'Cache-Control': 'private, no-store' };
const metadata = [
  'analysis_source',
  'explanation',
  'event_date',
  'financial_type',
  'transfer_to_account_id',
  'automation_fields',
  'history_fields',
  'applied_rules',
  'evidence_ids'
] as const;

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: privateHeaders });
}

async function readInput(request: Request): Promise<Record<string, unknown> | Response> {
  if (
    request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  )
    return response({ error: 'JSON content is required' }, 415);
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d{1,6}$/u.test(length) || Number(length) > 4096))
    return response({ error: 'Request is too large' }, 413);
  const reader = request.body?.getReader();
  if (!reader) return response({ error: 'Invalid JSON' }, 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        void reader.cancel().catch(() => undefined);
        return response({ error: 'Request is too large' }, 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
    );
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : response({ error: 'Invalid input' }, 400);
  } catch {
    return response({ error: 'Invalid JSON' }, 400);
  } finally {
    reader.releaseLock();
  }
}

function publicAnalysis(result: InboxAnalysisResult): Response {
  const { analysis_details: details, ...fields } = result;
  const selected =
    details && typeof details === 'object' && !Array.isArray(details)
      ? Object.fromEntries(
          metadata
            .filter((key) => Object.prototype.hasOwnProperty.call(details, key))
            .map((key) => [key, details[key]])
        )
      : {};
  return response({ ...fields, ...selected });
}

export async function handleInboxAnalyze(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
  try {
    const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
    const userId = await resolveUserId(request, env, services.apiKeys);
    if (!userId) return unauthorizedResponse();
    const input = await readInput(request);
    if (input instanceof Response) return input;
    const id = input.inbox_item_id;
    if (
      typeof id !== 'string' ||
      !uuid.test(id) ||
      (input.refresh !== undefined && typeof input.refresh !== 'boolean') ||
      Object.keys(input).some((key) => key !== 'inbox_item_id' && key !== 'refresh')
    )
      return response({ error: 'Invalid analysis request' }, 400);
    const item = await services.inboxAnalysis.item(userId, id);
    if (!item || item.id !== id || item.user_id !== userId)
      return response({ error: 'Inbox item not found' }, 404);
    const cached = await services.inboxAnalysis.analysis(userId, id);
    if (cached?.analysis_version === 3 && (!input.refresh || item.status !== 'pending'))
      return publicAnalysis(cached);
    if (item.status !== 'pending') return response({ error: 'Inbox item is not pending' }, 409);
    await services.inboxAnalysis.request(userId, id, input.refresh === true);
    const [lease] = await services.inboxAnalysis.claim(1, id, userId);
    if (lease) await processInboxAnalysisLease(lease, env);
    const [analysis, job] = await Promise.all([
      services.inboxAnalysis.analysis(userId, id),
      services.inboxAnalysis.job(userId, id)
    ]);
    if (analysis?.analysis_version === 3 && job?.state === 'ready') return publicAnalysis(analysis);
    if (job?.state === 'running' || job?.state === 'pending' || !job)
      return response({ state: job?.state ?? 'pending' }, 202);
    if (job.last_error === 'consent_required')
      return aiConsentErrorResponse(
        new AiConsentRequiredError(
          item.source === 'forwarded_email' ? 'forwarded_email' : 'financial_text'
        )
      )!;
    if (job.last_error === 'quota_limit')
      return response({ error: 'Parse limit reached', code: 'PARSE_LIMIT_REACHED' }, 429);
    if (job.last_error === 'unverified_source')
      return response({ error: 'Source is not verified', code: 'UNVERIFIED_SOURCE' }, 403);
    if (job.last_error === 'invalid_source')
      return response(
        { error: 'Capture is not suitable for analysis', code: 'INVALID_SOURCE' },
        422
      );
    if (job.state === 'skipped') return response({ error: 'Inbox item is not pending' }, 409);
    return response({ error: 'Analysis unavailable', code: 'ANALYSIS_UNAVAILABLE' }, 503);
  } catch (error) {
    return (
      aiConsentErrorResponse(error) ??
      response({ error: 'Analysis unavailable', code: 'ANALYSIS_UNAVAILABLE' }, 503)
    );
  }
}

export async function handleInboxAnalysisDispatch(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
  try {
    const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
    const userId = await resolveUserId(request, env, services.apiKeys);
    if (!userId) return unauthorizedResponse();
    const input = await readInput(request);
    if (input instanceof Response) return input;
    const raw = input.inbox_item_ids;
    if (
      Object.keys(input).length !== 1 ||
      !Array.isArray(raw) ||
      raw.length < 1 ||
      raw.length > 25 ||
      raw.some((id: unknown) => typeof id !== 'string' || !uuid.test(id))
    )
      return response({ error: 'Invalid dispatch request' }, 400);
    const ids = [...new Set(raw as string[])];
    const items = await Promise.all(ids.map((id) => services.inboxAnalysis.item(userId, id)));
    if (items.some((item, index) => !item || item.user_id !== userId || item.id !== ids[index]))
      return response({ error: 'Inbox item not found' }, 404);
    if (items.some((item) => item?.status !== 'pending'))
      return response({ error: 'Inbox item is not pending' }, 409);
    await Promise.all(ids.map((id) => services.inboxAnalysis.request(userId, id, false)));
    ctx.waitUntil(dispatchInboxAnalysis(env, userId, ids).catch(() => undefined));
    return response({ state: 'pending' }, 202);
  } catch {
    return response({ error: 'Analysis dispatch unavailable', code: 'ANALYSIS_UNAVAILABLE' }, 503);
  }
}
