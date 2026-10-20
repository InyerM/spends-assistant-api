import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
it('separates manual document completion from financial reconciliation with audited owner decisions', async () => {
  const db = new PGlite();
  const owner = '00000000-0000-4000-8000-000000000001',
    doc = '10000000-0000-4000-8000-000000000001';
  try {
    await db.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid primary key);INSERT INTO auth.users VALUES('${owner}');CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;CREATE FUNCTION has_accepted_required_terms() RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
 CREATE TABLE documents(id uuid primary key,user_id uuid,status text,document_type text,archived_at timestamptz,unique(id,user_id));CREATE TABLE document_observations(id uuid,document_id uuid,user_id uuid,status text,match_transaction_id uuid);CREATE TABLE statement_reconciliation_proofs(observation_id uuid,document_id uuid,valid boolean);CREATE TABLE statement_reconciliation_scopes(document_id uuid,user_id uuid);
 CREATE FUNCTION guard_statement_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD;END IF;RAISE EXCEPTION 'Audit is immutable';END$$;
 INSERT INTO documents VALUES('${doc}','${owner}','extracted','statement',null);SELECT set_config('test.uid','${owner}',false);`);
    const path = 'supabase/migrations/20261020000070_document_review_status.sql';
    if (existsSync(path)) await db.exec(readFileSync(path, 'utf8'));
    await db.query(`SELECT set_document_review_status('${doc}','completed')`);
    expect((await db.query('SELECT review_status FROM documents')).rows).toEqual([
      { review_status: 'completed' }
    ]);
    await db.query(`SELECT set_document_review_status('${doc}','active')`);
    await db.query(`SELECT set_document_review_status('${doc}','no_movements')`);
    expect((await db.query('SELECT count(*) FROM document_review_status_events')).rows).toEqual([
      { count: 3 }
    ]);
    await expect(db.exec("UPDATE documents SET review_status='active'")).rejects.toThrow(
      /audited/i
    );
    await db.exec(`SELECT set_config('test.uid','00000000-0000-4000-8000-000000000002',false)`);
    await expect(db.query(`SELECT set_document_review_status('${doc}','active')`)).rejects.toThrow(
      /not found/i
    );
    await db.exec(
      `SELECT set_config('test.uid','${owner}',false);UPDATE documents SET status='processing'`
    );
    expect((await db.query('SELECT review_status FROM documents')).rows).toEqual([
      { review_status: 'active' }
    ]);
    await expect(
      db.query(`SELECT set_document_review_status('${doc}','completed')`)
    ).rejects.toThrow(/Extract/i);
    await db.exec(
      `UPDATE documents SET status='extracted';INSERT INTO document_observations VALUES(gen_random_uuid(),'${doc}','${owner}','created',gen_random_uuid())`
    );
    await expect(
      db.query(`SELECT set_document_review_status('${doc}','no_movements')`)
    ).rejects.toThrow(/linked movements/i);
  } finally {
    await db.close();
  }
}, 15000);
