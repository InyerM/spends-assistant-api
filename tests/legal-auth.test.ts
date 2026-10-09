import { afterEach, expect, it, vi } from 'vitest';
import { resolveSupabaseJwtUserId } from '../src/utils/auth';
import type { Env } from '../src/types/env';

afterEach(() => vi.unstubAllGlobals());
it('rejects a new JWT account before terms are accepted, then permits its verified acceptance', async () => {
  const request = new Request('https://worker.example/financial/chat', {
    headers: { Authorization: 'Bearer jwt' }
  });
  const env = {
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_SERVICE_KEY: 'service',
    API_KEY: 'legacy'
  } as Env;
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      Response.json({ id: 'owner', app_metadata: { anotto_terms_required: true } })
    );
  vi.stubGlobal('fetch', fetchMock);
  expect(await resolveSupabaseJwtUserId(request, env)).toBeNull();
  fetchMock.mockResolvedValue(
    Response.json({
      id: 'owner',
      app_metadata: { anotto_terms_required: true, anotto_terms_version: '2026-10-08' }
    })
  );
  expect(await resolveSupabaseJwtUserId(request, env)).toBe('owner');
});
