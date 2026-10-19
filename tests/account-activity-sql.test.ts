import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
it('aggregates a complete ledger with six monthly buckets and excludes other owners and accounts', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-4000-8000-000000000001'::uuid $$;
 CREATE FUNCTION has_accepted_required_terms() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
 CREATE TABLE accounts(id uuid,user_id uuid,deleted_at timestamptz);
 CREATE TABLE categories(id uuid,user_id uuid,name text,translations jsonb);
 CREATE TABLE transactions(id uuid default gen_random_uuid(),account_id uuid,user_id uuid,date date,type text,amount numeric,category_id uuid,deleted_at timestamptz);
 INSERT INTO accounts VALUES('10000000-0000-4000-8000-000000000001',auth.uid(),null);
 INSERT INTO transactions(account_id,user_id,date,type,amount) VALUES('10000000-0000-4000-8000-000000000001',auth.uid(),current_date,'expense',50),('10000000-0000-4000-8000-000000000001',auth.uid(),current_date,'income',100),('10000000-0000-4000-8000-000000000001',auth.uid(),current_date,'transfer',500),('10000000-0000-4000-8000-000000000002',auth.uid(),current_date,'expense',1000);
 GRANT USAGE ON SCHEMA auth TO authenticated; GRANT SELECT ON accounts,categories,transactions TO authenticated;`);
    await db.exec(readFileSync('supabase/migrations/20261019000070_account_activity.sql', 'utf8'));
    await db.exec('SET ROLE authenticated;');
    const result = (
      await db.query<{
        result: { income: number; expenses: number; count: number; months: unknown[] };
      }>(`SELECT account_activity('10000000-0000-4000-8000-000000000001') result`)
    ).rows[0].result;
    expect(result).toMatchObject({ income: 100, expenses: 50, count: 3 });
    expect(result.months).toHaveLength(6);
    await expect(
      db.query(`SELECT account_activity('10000000-0000-4000-8000-000000000002')`)
    ).rejects.toThrow(/not found/i);
  } finally {
    await db.close();
  }
}, 15000);
