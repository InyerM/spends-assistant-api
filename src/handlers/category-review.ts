import { ReviewTransactionNotFoundError } from '../services/supabase/category-review-context.service';
import type { CategoryReviewInput } from '../ai/category-review';
import { reviewCategoryProposal, CategoryReviewQuotaError } from '../services/category-review';
import { OpenRouterError } from '../ai/openrouter';
import { createSupabaseServices } from '../services/supabase';
import { resolveUserId, unauthorizedResponse } from '../utils/auth';
import { aiConsentErrorResponse } from '../utils/ai-consent-response';
import type { Env } from '../types/env';
function validInput(value: unknown): value is CategoryReviewInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    ['es', 'en', 'pt'].includes(String(v.locale)) &&
    ['expense', 'income', 'transfer'].includes(String(v.type)) &&
    typeof v.description === 'string' &&
    v.description.length <= 500 &&
    (v.notes === undefined || (typeof v.notes === 'string' && v.notes.length <= 1500)) &&
    (v.excerpt === undefined || (typeof v.excerpt === 'string' && v.excerpt.length <= 3000)) &&
    (v.review_fields === undefined ||
      (Array.isArray(v.review_fields) &&
        v.review_fields.length > 0 &&
        v.review_fields.length <= 3 &&
        new Set(v.review_fields).size === v.review_fields.length &&
        v.review_fields.every((field) =>
          ['category', 'description', 'notes'].includes(String(field))
        ))) &&
    (v.event_date === undefined ||
      (typeof v.event_date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(v.event_date) &&
        Number.isFinite(Date.parse(v.event_date)) &&
        new Date(v.event_date).toISOString().slice(0, 10) === v.event_date)) &&
    (v.account_type === undefined ||
      (typeof v.account_type === 'string' && v.account_type.length <= 30)) &&
    (v.category_id === undefined || typeof v.category_id === 'string') &&
    (v.transaction_id === undefined ||
      (typeof v.transaction_id === 'string' && /^[0-9a-f-]{36}$/i.test(v.transaction_id))) &&
    (v.amount === undefined ||
      (typeof v.amount === 'number' && Number.isFinite(v.amount) && v.amount > 0)) &&
    (v.account_id === undefined ||
      (typeof v.account_id === 'string' && /^[0-9a-f-]{36}$/i.test(v.account_id))) &&
    (v.source === undefined || (typeof v.source === 'string' && v.source.length <= 40)) &&
    Array.isArray(v.history) &&
    v.history.length <= 12 &&
    v.history.every(
      (row) =>
        row &&
        typeof row === 'object' &&
        typeof row.id === 'string' &&
        row.id.length <= 80 &&
        typeof row.description === 'string' &&
        row.description.length <= 500 &&
        typeof row.category === 'string' &&
        row.category.length <= 150 &&
        (row.notes === undefined ||
          row.notes === null ||
          (typeof row.notes === 'string' && row.notes.length <= 1500))
    )
  );
}
export async function handleCategoryReview(request: Request, env: Env): Promise<Response> {
  try {
    const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
    const userId = await resolveUserId(request, env, services.apiKeys);
    if (!userId) return unauthorizedResponse();
    const input: unknown = await request.json().catch(() => null);
    if (!validInput(input))
      return Response.json({ error: 'Invalid review context' }, { status: 400 });
    const result = await reviewCategoryProposal(userId, input, env, services);
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof CategoryReviewQuotaError)
      return Response.json({ error: 'Parse limit reached' }, { status: 429 });
    if (error instanceof ReviewTransactionNotFoundError)
      return Response.json({ error: 'Review transaction not found' }, { status: 404 });
    const consentResponse = aiConsentErrorResponse(error);
    if (consentResponse) return consentResponse;
    console.error('category_review_failed', {
      model: env.OPENROUTER_TEXT_MODEL ?? 'deepseek/deepseek-v4.1-flash',
      reason: error instanceof OpenRouterError ? error.reason : 'internal',
      ...(error instanceof OpenRouterError && error.stage ? { stage: error.stage } : {}),
      upstream_status: error instanceof OpenRouterError ? error.status : null
    });
    return Response.json({ error: 'Category review unavailable' }, { status: 503 });
  }
}
