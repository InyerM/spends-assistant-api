import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { it, expect } from 'vitest';
it('exposes only confirmed owner capture locations, never pending or reversed sources', async () => {
  const db = new PGlite();
  try {
    await db.exec(
      `CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;CREATE FUNCTION public.has_accepted_required_terms() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;CREATE TABLE shortcut_inbox_items(id uuid,user_id uuid,status text);CREATE TABLE shortcut_inbox_match_decisions(inbox_item_id uuid,user_id uuid,transaction_id uuid);CREATE TABLE transactions(id uuid,user_id uuid,date date,amount numeric,description text,type text,is_active boolean,deleted_at timestamptz,account_id uuid);CREATE TABLE accounts(id uuid,user_id uuid,currency text);`
    );
    await db.exec(readFileSync('supabase/migrations/20261010000056_capture_locations.sql', 'utf8'));
    const owner = '11111111-1111-4111-8111-111111111111',
      inbox = '22222222-2222-4222-8222-222222222222',
      tx = '33333333-3333-4333-8333-333333333333',
      account = '44444444-4444-4444-8444-444444444444';
    await db.exec(
      `SELECT set_config('request.jwt.claim.sub','${owner}',false);INSERT INTO shortcut_inbox_items VALUES('${inbox}','${owner}','pending','{"latitude":4.8,"longitude":-75.7,"captured_at":"2026-10-10T12:00:00Z"}');INSERT INTO accounts VALUES('${account}','${owner}','COP');INSERT INTO transactions VALUES('${tx}','${owner}','2026-10-10',10,'Synthetic purchase','expense',true,NULL,'${account}');INSERT INTO shortcut_inbox_match_decisions VALUES('${inbox}','${owner}','${tx}');`
    );
    expect((await db.query('SELECT * FROM get_purchase_locations(100,0)')).rows).toHaveLength(0);
    await db.exec(`UPDATE shortcut_inbox_items SET status='matched' WHERE id='${inbox}'`);
    expect((await db.query('SELECT * FROM get_purchase_locations(100,0)')).rows).toHaveLength(1);
    await db.exec(
      `SELECT set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555555',false)`
    );
    expect((await db.query('SELECT * FROM get_purchase_locations(100,0)')).rows).toHaveLength(0);
    await expect(
      db.exec(
        `INSERT INTO shortcut_inbox_items(id,capture_location) VALUES('66666666-6666-4666-8666-666666666666','{"latitude":200,"longitude":0,"captured_at":"2026-10-10T12:00:00Z"}')`
      )
    ).rejects.toThrow();
  } finally {
    await db.close();
  }
});
