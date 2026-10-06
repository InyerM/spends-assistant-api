import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSupabaseJwtUserId } from '../../src/utils/auth';
import { createMockEnv } from '../__test-helpers__/factories';

const env = createMockEnv();

afterEach(() => vi.unstubAllGlobals());

describe('consent identity verification', () => {
  it('rejects legacy and delegated API keys for consent mutations', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    const legacy = new Request('https://worker.test/ai/consent', {
      headers: { Authorization: `Bearer ${env.API_KEY}` }
    });
    const delegated = new Request('https://worker.test/ai/consent', {
      headers: { Authorization: 'Bearer delegated-api-key' }
    });
    expect(await resolveSupabaseJwtUserId(legacy, env)).toBeNull();
    expect(await resolveSupabaseJwtUserId(delegated, env)).toBeNull();
  });

  it('accepts only the owner returned by Supabase Auth for a valid JWT', async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 'owner-1' }));
    vi.stubGlobal('fetch', fetcher);
    const request = new Request('https://worker.test/ai/consent', {
      headers: { Authorization: 'Bearer authenticated-user-jwt' }
    });
    expect(await resolveSupabaseJwtUserId(request, env)).toBe('owner-1');
    expect(fetcher).toHaveBeenCalledWith(
      `${env.SUPABASE_URL}/auth/v1/user`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer authenticated-user-jwt' })
      })
    );
  });
});
