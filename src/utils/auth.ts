import { Env } from '../types/env';
import { ApiKeysService } from '../services/supabase/api-keys.service';

export interface AuthResult {
  userId: string;
}

/**
 * Resolves the authenticated user from the request.
 * Tries in order: per-user API key → legacy static API_KEY → Supabase JWT.
 * Returns null if no valid auth is found.
 */
export async function resolveUserId(
  request: Request,
  env: Env,
  apiKeysService: ApiKeysService
): Promise<string | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);

  // 1. Per-user API key (hashed lookup)
  const userId = await apiKeysService.resolveUser(token);
  if (userId) return userId;

  // 2. Legacy static API_KEY
  if (token === env.API_KEY) return env.DEFAULT_USER_ID;

  // 3. Supabase JWT verification
  return resolveSupabaseJwtUserId(request, env);
}

/** Consent changes require an interactive Supabase session, not a delegated API key. */
export async function resolveSupabaseJwtUserId(request: Request, env: Env): Promise<string | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  if (!token || token === env.API_KEY) return null;
  try {
    const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: env.SUPABASE_SERVICE_KEY
      }
    });
    if (userRes.ok) {
      const user = (await userRes.json()) as {
        id?: unknown;
        app_metadata?: { anotto_terms_required?: unknown; anotto_terms_version?: unknown };
      };
      if (
        user.app_metadata?.anotto_terms_required === true &&
        user.app_metadata.anotto_terms_version !== '2026-10-08'
      )
        return null;
      return typeof user.id === 'string' && user.id.length > 0 ? user.id : null;
    }
  } catch {
    // JWT verification failed
  }

  return null;
}

/** Returns a 401 JSON response. */
export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' }
  });
}
