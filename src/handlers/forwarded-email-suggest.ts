import { OpenRouterError } from '../ai/openrouter';
import { suggestForwardedEmail } from '../ai/forwarded-email-suggestion';
import { createSupabaseServices } from '../services/supabase';
import type { Env } from '../types/env';
import { resolveUserId, unauthorizedResponse } from '../utils/auth';
import { aiConsentErrorResponse } from '../utils/ai-consent-response';

export async function handleForwardedEmailSuggest(request: Request, env: Env): Promise<Response> {
  const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const userId = await resolveUserId(request, env, services.apiKeys);
  if (!userId) return unauthorizedResponse();
  let message: unknown;
  try {
    ({ message } = (await request.json()) as { message?: unknown });
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (typeof message !== 'string' || message.trim().length < 10 || message.length > 12000) {
    return Response.json({ error: 'Invalid email text' }, { status: 400 });
  }
  try {
    const categories = await services.categories.getCategories(userId);
    const suggestion = await suggestForwardedEmail(
      message,
      categories,
      env.OPENROUTER_API_KEY,
      env.OPENROUTER_TEXT_MODEL ?? 'deepseek/deepseek-v4.1-flash',
      userId,
      services.aiUsage
    );
    return Response.json({
      type: suggestion.type,
      category_id: suggestion.categoryId,
      category_source: suggestion.categorySource,
      description: suggestion.description,
      notes: suggestion.notes,
      bank_event_at: suggestion.bankEventAt ?? null
    });
  } catch (error) {
    const consentResponse = aiConsentErrorResponse(error);
    if (consentResponse) return consentResponse;
    console.error('forwarded_email_suggestion_failed', {
      operation: 'triage_forwarded_email',
      model: env.OPENROUTER_TEXT_MODEL ?? 'deepseek/deepseek-v4.1-flash',
      reason: error instanceof OpenRouterError ? error.reason : 'internal',
      ...(error instanceof OpenRouterError && error.stage ? { stage: error.stage } : {}),
      upstream_status: error instanceof OpenRouterError ? error.status : null
    });
    return Response.json({ error: 'Email suggestion unavailable' }, { status: 503 });
  }
}
