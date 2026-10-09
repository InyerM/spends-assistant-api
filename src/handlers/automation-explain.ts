import { createSupabaseServices } from '../services/supabase';
import type { Env } from '../types/env';
import { completeJson } from '../ai/openrouter';
import { resolveUserId, unauthorizedResponse } from '../utils/auth';
import { aiConsentErrorResponse } from '../utils/ai-consent-response';
import {
  explanationFingerprint,
  normalizeExplanationRule,
  explanationFailureCode
} from '../utils/automation-explanation';
import { automationExplanationSystemPrompt } from '../constants/automation-explanation-system-prompt';

const pending = new Map<string, Promise<string>>();

export async function handleAutomationExplain(request: Request, env: Env): Promise<Response> {
  let stage = 'authentication';
  try {
    const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
    const userId = await resolveUserId(request, env, services.apiKeys);
    if (!userId) return unauthorizedResponse();
    let body: { rule?: unknown; locale?: unknown };
    let rule;
    try {
      body = (await request.json()) as typeof body;
      rule = normalizeExplanationRule(body?.rule);
    } catch {
      return Response.json({ error: 'Invalid automation draft' }, { status: 400 });
    }
    const locale = ['en', 'es', 'pt'].includes(String(body.locale)) ? String(body.locale) : 'es';
    stage = 'context';
    const [accounts, categories] = await Promise.all([
      services.accounts.getAccounts(userId),
      services.categories.getCategories(userId)
    ]);
    const accountIds = new Set([
      rule.conditions.from_account,
      rule.conditions.to_account,
      rule.actions.set_account,
      rule.actions.link_to_account,
      rule.transfer_to_account_id
    ]);
    const categoryIds = new Set([rule.conditions.category, rule.actions.set_category]);
    const accountContext = accounts
      .filter((account) => accountIds.has(account.id))
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const categoryContext = categories
      .filter((category) => categoryIds.has(category.id))
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.id.localeCompare(b.id));
    stage = 'fingerprint';
    const fingerprint = await explanationFingerprint(rule, accountContext, categoryContext);
    stage = 'cache_read';
    const cached = await services.automationRules.getExplanation(userId, fingerprint, locale);
    if (cached)
      return Response.json(
        { explanation: cached, fingerprint, cached: true },
        { headers: { 'Cache-Control': 'private, no-store' } }
      );
    stage = 'generation';
    const key = `${userId}:${fingerprint}:${locale}`;
    let generation = pending.get(key);
    if (!generation) {
      const model = env.OPENROUTER_TEXT_MODEL ?? 'deepseek/deepseek-v4.1-flash';
      generation = services.aiUsage.track(
        { userId, operation: 'generate_automation', model },
        async (meter) => {
          const { data } = await completeJson<{ explanation: string }>({
            apiKey: env.OPENROUTER_API_KEY,
            model,
            system: automationExplanationSystemPrompt,
            user: JSON.stringify({
              language: locale,
              rule,
              accounts: accountContext,
              categories: categoryContext
            }),
            meter
          });
          stage = 'validation';
          if (
            !data ||
            typeof data !== 'object' ||
            Array.isArray(data) ||
            typeof data.explanation !== 'string' ||
            !data.explanation.trim() ||
            data.explanation.length > 3000
          )
            throw new Error('Invalid automation explanation');
          stage = 'cache_write';
          await services.automationRules.saveExplanation(
            userId,
            fingerprint,
            locale,
            data.explanation.trim()
          );
          return data.explanation.trim();
        }
      );
      pending.set(key, generation);
      void generation.finally(() => pending.delete(key)).catch(() => undefined);
    }
    return Response.json(
      { explanation: await generation, fingerprint, cached: false },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (error) {
    const consent = aiConsentErrorResponse(error);
    if (consent) return consent;
    console.error('[Automation explanation] Failed', {
      stage,
      code: explanationFailureCode(error)
    });
    return Response.json(
      {
        code: 'AUTOMATION_EXPLANATION_UNAVAILABLE',
        stage,
        reason: explanationFailureCode(error),
        error: 'Explanation unavailable; you can still save the rule'
      },
      { status: 503 }
    );
  }
}
