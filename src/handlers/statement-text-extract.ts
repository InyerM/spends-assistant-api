import { extractStatementText, STATEMENT_TEXT_MODEL } from '../ai/statement-text';
import { createSupabaseServices } from '../services/supabase';
import type { Env } from '../types/env';
import { resolveUserId, unauthorizedResponse } from '../utils/auth';
import { aiConsentErrorResponse } from '../utils/ai-consent-response';
/** Extracts bounded local PDF text into review drafts only. */
export async function handleStatementTextExtract(request: Request, env: Env): Promise<Response> {
  const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const userId = await resolveUserId(request, env, services.apiKeys);
  if (!userId) return unauthorizedResponse();
  try {
    const raw = await request.text();
    if (raw.length > 200000)
      return Response.json({ error: 'Statement text too large' }, { status: 413 });
    const body: unknown = JSON.parse(raw);
    const pages =
      body && typeof body === 'object' && 'pages' in body
        ? (body as { pages: unknown }).pages
        : null;
    if (
      !Array.isArray(pages) ||
      pages.length < 1 ||
      pages.length > 10 ||
      pages.some(
        (page: unknown) =>
          typeof page !== 'string' || page.trim().length < 20 || page.length > 20000
      ) ||
      (pages as string[]).reduce((sum, page) => sum + page.length, 0) > 40000
    ) {
      return Response.json({ error: 'Invalid statement pages' }, { status: 400 });
    }
    await services.aiConsent.require(userId, 'financial_text');
    const usage = await services.usage.incrementAiParses(userId);
    if (!usage.allowed)
      return Response.json({ code: 'PARSE_LIMIT_REACHED', ...usage }, { status: 429 });
    const result = await services.aiUsage.track(
      { userId, operation: 'extract_document', model: STATEMENT_TEXT_MODEL },
      (meter) =>
        extractStatementText({ pages: pages as string[], apiKey: env.OPENROUTER_API_KEY, meter })
    );
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    const consentError = aiConsentErrorResponse(error);
    if (consentError) return consentError;
    return Response.json(
      { error: 'Statement extraction failed' },
      { status: error instanceof SyntaxError ? 400 : 502 }
    );
  }
}
