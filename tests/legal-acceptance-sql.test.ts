import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

it('requires terms only for new users and records an owner acceptance exactly once', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid PRIMARY KEY, raw_app_meta_data jsonb DEFAULT '{}');
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      INSERT INTO auth.users VALUES ('11111111-1111-4111-8111-111111111111','{}');
      CREATE TABLE public.transactions(id uuid, user_id uuid);
      ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
      CREATE POLICY owner ON public.transactions TO authenticated USING (user_id=auth.uid()) WITH CHECK(user_id=auth.uid());
      GRANT ALL ON public.transactions TO authenticated;
      CREATE FUNCTION public.test_definer_write() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
        INSERT INTO public.transactions VALUES(gen_random_uuid(),auth.uid()) $$;
      GRANT EXECUTE ON FUNCTION public.test_definer_write() TO authenticated;`);
    await db.exec(
      readFileSync(
        new URL('../supabase/migrations/20261008000022_legal_acceptance.sql', import.meta.url),
        'utf8'
      )
    );
    await db.exec(`INSERT INTO auth.users VALUES ('22222222-2222-4222-8222-222222222222','{}');
      SET request.jwt.claim.sub='11111111-1111-4111-8111-111111111111'; SET ROLE authenticated;`);
    expect(
      (
        await db.query<{ allowed: boolean }>(
          'SELECT public.has_accepted_required_terms() AS allowed'
        )
      ).rows[0].allowed
    ).toBe(true);
    await db.exec(
      `RESET ROLE; SET request.jwt.claim.sub='22222222-2222-4222-8222-222222222222'; SET ROLE authenticated;`
    );
    expect(
      (
        await db.query<{ allowed: boolean }>(
          'SELECT public.has_accepted_required_terms() AS allowed'
        )
      ).rows[0].allowed
    ).toBe(false);
    await expect(db.query('SELECT public.test_definer_write()')).rejects.toThrow(
      'Terms acceptance required'
    );
    await expect(db.query("SELECT public.accept_current_terms('wrong')")).rejects.toThrow();
    await db.query("SELECT public.accept_current_terms('2026-10-08')");
    await db.query("SELECT public.accept_current_terms('2026-10-08')");
    expect(
      (
        await db.query<{ allowed: boolean }>(
          'SELECT public.has_accepted_required_terms() AS allowed'
        )
      ).rows[0].allowed
    ).toBe(true);
    expect((await db.query('SELECT * FROM public.legal_acceptances')).rows).toHaveLength(1);
    await db.query('SELECT public.test_definer_write()');
    expect((await db.query('SELECT * FROM public.transactions')).rows).toHaveLength(1);
    await expect(
      db.query("UPDATE public.legal_acceptances SET version='forged'")
    ).rejects.toThrow();
  } finally {
    await db.close();
  }
});
