import {
  AI_CONSENT_VERSION,
  AiConsentRequiredError,
  AiConsentUnavailableError
} from '../services/supabase/ai-consent.service';

export function aiConsentErrorResponse(error: unknown): Response | null {
  if (error instanceof AiConsentRequiredError) {
    return Response.json(
      {
        error: 'AI consent required',
        code: error.code,
        scope: error.scope,
        version: AI_CONSENT_VERSION
      },
      { status: 428, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }
  if (error instanceof AiConsentUnavailableError) {
    return Response.json(
      { error: 'AI consent unavailable', code: error.code },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }
  return null;
}
