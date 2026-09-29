import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../supabase/migrations/20260929000020_atomic_csv_import.sql', import.meta.url),
  'utf8'
);
const owner = '11111111-1111-4111-8111-111111111111';
const account = '22222222-2222-4222-8222-222222222222';

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE TABLE public.accounts (id uuid PRIMARY KEY, user_id uuid NOT NULL,
      balance numeric(15,2), deleted_at timestamptz);
    CREATE TABLE public.categories (id uuid PRIMARY KEY, user_id uuid NOT NULL);
    CREATE TABLE public.imports (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL, source text NOT NULL, file_name text NOT NULL,
      file_path text, row_count integer NOT NULL, imported_count integer NOT NULL,
      status text NOT NULL);
    CREATE TABLE public.transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL, import_id uuid, date date NOT NULL, time time NOT NULL,
      amount numeric(15,2) NOT NULL, description text NOT NULL, notes text,
      type text NOT NULL, payment_method text, source text NOT NULL,
      account_id uuid NOT NULL REFERENCES public.accounts(id), category_id uuid,
      duplicate_status text, deleted_at timestamptz);
    CREATE TABLE public.usage_tracking (user_id uuid NOT NULL, month text NOT NULL,
      transactions_count integer NOT NULL DEFAULT 0, updated_at timestamptz DEFAULT now(),
      PRIMARY KEY (user_id, month));
    CREATE TABLE public.subscriptions (user_id uuid PRIMARY KEY, plan text NOT NULL,
      status text NOT NULL);
    CREATE TABLE public.app_settings (key text PRIMARY KEY, value jsonb NOT NULL);
    INSERT INTO public.accounts VALUES ('${account}', '${owner}', 10000, NULL);
    INSERT INTO public.subscriptions VALUES ('${owner}', 'pro', 'canceled');
    INSERT INTO public.app_settings VALUES ('free_transactions_limit', '1');
    INSERT INTO public.usage_tracking VALUES ('${owner}',
      to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'), 1, now());
  `);
  await db.exec(migration);
  return db;
}

async function confirm(db: PGlite, requestId: string): Promise<unknown> {
  await db.exec(`SET request.jwt.claim.sub = '${owner}'; SET ROLE authenticated;`);
  try {
    return await db.query(`SELECT public.confirm_csv_import(
      '${requestId}', '{}'::jsonb,
      '[{"amount":100,"date":"2026-09-28","account_id":"${account}",
        "description":"Synthetic test expense","type":"expense"}]'::jsonb,
      '[]'::jsonb, 'synthetic.csv', 1, false)`);
  } finally {
    await db.exec('RESET ROLE;');
  }
}

describe('atomic CSV import transaction quota', () => {
  it('treats canceled pro as free and rejects an import above the configured limit', async () => {
    const db = await database();
    try {
      await expect(confirm(db, '33333333-3333-4333-8333-333333333333')).rejects.toThrow(
        /Transaction limit exceeded/
      );
      expect((await db.query('SELECT count(*)::integer AS count FROM public.transactions')).rows).toEqual([
        { count: 0 },
      ]);
    } finally {
      await db.close();
    }
  });

  it('allows active pro above the free limit and records the import in the UTC month', async () => {
    const db = await database();
    try {
      await db.exec(`UPDATE public.subscriptions SET status = 'active' WHERE user_id = '${owner}'`);
      await confirm(db, '44444444-4444-4444-8444-444444444444');
      expect(
        (await db.query(`SELECT transactions_count FROM public.usage_tracking
          WHERE user_id = '${owner}' AND month = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')`)).rows
      ).toEqual([{ transactions_count: 2 }]);
    } finally {
      await db.close();
    }
  });
});
