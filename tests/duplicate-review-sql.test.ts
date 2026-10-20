import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
it('confirms only an owner duplicate decision and records evidence without changing money', async () => {
  const db = new PGlite();
  try {
    await db.exec(
      `CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT current_setting('test.uid')::uuid$$;CREATE FUNCTION has_accepted_required_terms() RETURNS boolean LANGUAGE sql AS $$SELECT true$$;CREATE TABLE transactions(id uuid,user_id uuid,duplicate_status text,duplicate_of uuid,deleted_at timestamptz,amount numeric,raw_text text);CREATE TABLE transaction_review_metadata_edits(user_id uuid,transaction_id uuid,before_state jsonb,after_state jsonb);INSERT INTO transactions VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','pending_review','00000000-0000-4000-8000-000000000003',NULL,100,'Bank evidence');SELECT set_config('test.uid','00000000-0000-4000-8000-000000000002',false);`
    );
    const path = 'supabase/migrations/20261020000030_duplicate_review.sql';
    if (existsSync(path)) await db.exec(readFileSync(path, 'utf8'));
    await db.query(
      "SELECT confirm_transaction_not_duplicate('00000000-0000-4000-8000-000000000001')"
    );
    expect(
      (await db.query('SELECT duplicate_status,amount,raw_text FROM transactions')).rows
    ).toEqual([{ duplicate_status: 'confirmed', amount: '100', raw_text: 'Bank evidence' }]);
    expect((await db.query('SELECT count(*) FROM transaction_review_metadata_edits')).rows).toEqual(
      [{ count: 1 }]
    );
    await db.query(
      "SELECT confirm_transaction_not_duplicate('00000000-0000-4000-8000-000000000001')"
    );
    expect((await db.query('SELECT count(*) FROM transaction_review_metadata_edits')).rows).toEqual(
      [{ count: 1 }]
    );
    await db.exec("SELECT set_config('test.uid','00000000-0000-4000-8000-000000000004',false)");
    await expect(
      db.query("SELECT confirm_transaction_not_duplicate('00000000-0000-4000-8000-000000000001')")
    ).rejects.toThrow('Transaction not found');
  } finally {
    await db.close();
  }
}, 15000);
