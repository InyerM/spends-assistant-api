import { classifyForwardedPurchase } from '../ai/forwarded-purchase-category';
import { createSupabaseServices } from '../services/supabase';
import type { Env } from '../types/env';
import { resolveUserId, unauthorizedResponse } from '../utils/auth';

export async function handleMerchantSuggest(request: Request, env: Env): Promise<Response> {
  const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const userId = await resolveUserId(request, env, services.apiKeys);
  if (!userId) return unauthorizedResponse();

  let merchant: unknown;
  try {
    ({ merchant } = (await request.json()) as { merchant?: unknown });
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (
    typeof merchant !== 'string' ||
    merchant.trim().length < 2 ||
    merchant.trim().length > 120 ||
    [...merchant].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  ) {
    return Response.json({ error: 'Invalid merchant' }, { status: 400 });
  }

  try {
    const categories = await services.categories.getCategories(userId);
    const suggestion = await classifyForwardedPurchase(
      merchant.trim(),
      categories,
      env.OPENROUTER_API_KEY,
      env.OPENROUTER_TEXT_MODEL ?? 'deepseek/deepseek-v4.1-flash',
      userId,
      services.aiUsage
    );
    const category = categories.find(
      (candidate) =>
        candidate.id === suggestion?.categoryId &&
        candidate.user_id === userId &&
        candidate.type === 'expense' &&
        candidate.is_active
    );
    return Response.json({
      category_id: category?.id ?? null,
      source: category ? (suggestion?.model === 'merchant-catalog-v1' ? 'catalog' : 'ai') : null
    });
  } catch {
    return Response.json({ error: 'Merchant suggestion unavailable' }, { status: 503 });
  }
}
