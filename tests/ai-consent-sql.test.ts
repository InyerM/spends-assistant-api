import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const owner = '00000000-0000-4000-8000-000000000001';
const stranger = '00000000-0000-4000-8000-000000000002';

describe('AI consent migration', () => {
  it('keeps decisions owner-scoped and blocks direct client writes', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE ROLE authenticated;
        CREATE ROLE anon;
        CREATE ROLE service_role;
        CREATE SCHEMA auth;
        CREATE TABLE auth.users(id uuid PRIMARY KEY);
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
          SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
        $$;
        INSERT INTO auth.users VALUES ('${owner}'), ('${stranger}');
      `);
      await db.exec(
        readFileSync(
          join(process.cwd(), 'supabase/migrations/20261006000020_external_ai_consent.sql'),
          'utf8'
        )
      );
      await db.exec(`
        INSERT INTO public.ai_consent_decisions(user_id, scope, version, granted_at)
        VALUES ('${owner}', 'financial_text', 'external-ai-v1', now());
      `);
      await db.exec(`SET request.jwt.claim.sub = '${stranger}'; SET ROLE authenticated;`);
      expect((await db.query('SELECT * FROM public.ai_consent_decisions')).rows).toEqual([]);
      await expect(
        db.exec(`INSERT INTO public.ai_consent_decisions(user_id, scope, version)
          VALUES ('${stranger}', 'financial_text', 'external-ai-v1')`)
      ).rejects.toThrow();
      await db.exec(`RESET ROLE; SET request.jwt.claim.sub = '${owner}'; SET ROLE authenticated;`);
      expect((await db.query('SELECT scope FROM public.ai_consent_decisions')).rows).toEqual([
        { scope: 'financial_text' }
      ]);
    } finally {
      await db.close();
    }
  });
});
