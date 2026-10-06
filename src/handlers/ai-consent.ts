import { createSupabaseServices } from '../services/supabase';
import {
  AI_CONSENT_SCOPES,
  AI_CONSENT_VERSION,
  AiConsentUnavailableError,
  type AiConsentScope
} from '../services/supabase/ai-consent.service';
import type { Env } from '../types/env';
import { resolveSupabaseJwtUserId, resolveUserId, unauthorizedResponse } from '../utils/auth';

const privateHeaders = { 'Cache-Control': 'private, no-store' };

export async function handleAiConsent(request: Request, env: Env): Promise<Response> {
  const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const userId =
    request.method === 'POST'
      ? await resolveSupabaseJwtUserId(request, env)
      : await resolveUserId(request, env, services.apiKeys);
  if (!userId) return unauthorizedResponse();

  try {
    if (request.method === 'GET') {
      return Response.json(await services.aiConsent.getState(userId), { headers: privateHeaders });
    }
    if (request.method !== 'POST')
      return Response.json({ error: 'Method not allowed' }, { status: 405 });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (!body || typeof body !== 'object') {
      return Response.json({ error: 'Invalid consent decision' }, { status: 400 });
    }
    const { scope, granted, version } = body as Record<string, unknown>;
    if (
      typeof scope !== 'string' ||
      !AI_CONSENT_SCOPES.includes(scope as AiConsentScope) ||
      typeof granted !== 'boolean' ||
      typeof version !== 'string'
    ) {
      return Response.json({ error: 'Invalid consent decision' }, { status: 400 });
    }
    if (granted && version !== AI_CONSENT_VERSION) {
      return Response.json(
        {
          error: 'Consent disclosure version changed',
          code: 'AI_CONSENT_VERSION_CHANGED',
          version: AI_CONSENT_VERSION
        },
        { status: 409, headers: privateHeaders }
      );
    }
    await services.aiConsent.setDecision(
      userId,
      scope as AiConsentScope,
      granted,
      AI_CONSENT_VERSION
    );
    return Response.json(await services.aiConsent.getState(userId), { headers: privateHeaders });
  } catch (error) {
    if (error instanceof AiConsentUnavailableError) {
      return Response.json(
        { error: 'AI consent unavailable', code: error.code },
        { status: 503, headers: privateHeaders }
      );
    }
    return Response.json(
      { error: 'AI consent unavailable', code: 'AI_CONSENT_UNAVAILABLE' },
      { status: 503, headers: privateHeaders }
    );
  }
}
