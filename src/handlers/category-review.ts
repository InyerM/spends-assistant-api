import { reviewCategory, type CategoryReviewInput } from '../ai/category-review';
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
    (v.account_type === undefined ||
      (typeof v.account_type === 'string' && v.account_type.length <= 30)) &&
    (v.category_id === undefined || typeof v.category_id === 'string') &&
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
    await services.aiUsage.requireConsent(userId, 'financial_text');
    const categories = await services.categories.getCategories(userId);
    const quota = await services.usage.incrementAiParses(userId);
    if (!quota.allowed) return Response.json({ error: 'Parse limit reached' }, { status: 429 });
    const model = env.OPENROUTER_TEXT_MODEL ?? 'deepseek/deepseek-v4.1-flash';
    const result = await services.aiUsage.track(
      { userId, operation: 'parse_expense', model },
      (meter) => reviewCategory(input, categories, env.OPENROUTER_API_KEY, model, meter)
    );
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return (
      aiConsentErrorResponse(error) ??
      Response.json({ error: 'Category review unavailable' }, { status: 503 })
    );
  }
}
