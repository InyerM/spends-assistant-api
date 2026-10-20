import { reviewCategory, type CategoryReviewInput } from '../ai/category-review';
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
    await services.aiUsage.requireConsent(userId, 'financial_text');
    const [categories, history, rules] = await Promise.all([
      services.categories.getCategories(userId),
      services.categoryReviewContext.history(
        userId,
        input.description,
        input.type,
        input.transaction_id
      ),
      services.automationRules.getAutomationRules(userId)
    ]);
    const categoryRule = rules.find(
      (rule) =>
        rule.rule_type !== 'account_detection' &&
        !rule.conditions.to_account &&
        (!rule.conditions.category || rule.conditions.category === input.category_id) &&
        rule.actions.set_category &&
        (!rule.actions.set_type || rule.actions.set_type === input.type) &&
        categories.some(
          (category) => category.id === rule.actions.set_category && category.type === input.type
        ) &&
        services.automationRules.matchesConditions(
          {
            description: input.description,
            raw_text: input.excerpt,
            amount: input.amount,
            account_id: input.account_id,
            source: input.source,
            category_id: input.category_id
          },
          rule.conditions,
          rule.condition_logic
        )
    );
    const context = {
      preferences: rules
        .map((rule) => rule.prompt_text?.slice(0, 1000))
        .filter((value): value is string => Boolean(value))
        .slice(0, 12),
      ...(categoryRule?.actions.set_category
        ? {
            categoryRule: {
              category_id: categoryRule.actions.set_category,
              name: categoryRule.name.slice(0, 100)
            }
          }
        : {})
    };
    const quota = await services.usage.incrementAiParses(userId);
    if (!quota.allowed) return Response.json({ error: 'Parse limit reached' }, { status: 429 });
    const model = env.OPENROUTER_TEXT_MODEL ?? 'deepseek/deepseek-v4.1-flash';
    const result = await services.aiUsage.track(
      { userId, operation: 'parse_expense', model },
      (meter) =>
        reviewCategory(
          { ...input, history },
          categories,
          env.OPENROUTER_API_KEY,
          model,
          meter,
          context
        )
    );
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
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
