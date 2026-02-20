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
  apiKeysService: ApiKeysService,
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
  try {
    const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: env.SUPABASE_SERVICE_KEY,
      },
    });
    if (userRes.ok) {
      const user = (await userRes.json()) as { id: string };
      return user.id;
    }
  } catch {
    // JWT verification failed
  }

  return null;
}

/** Returns a 401 JSON response. */
export function unauthorizedResponse(): Response {
  return new Response(
    JSON.stringify({ error: 'Unauthorized' }),
    { status: 401, headers: { 'Content-Type': 'application/json' } },
  );
}
