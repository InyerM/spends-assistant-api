import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

const owner = '00000000-0000-4000-8000-000000000001';
const stranger = '00000000-0000-4000-8000-000000000002';
const email = '10000000-0000-4000-8000-000000000001';
const doc = '20000000-0000-4000-8000-000000000001';
const prior = '20000000-0000-4000-8000-000000000002';

it('atomically archives owned email attachments and restores only those archived by dismissal', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role; CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      CREATE TABLE shortcut_inbox_items(id uuid PRIMARY KEY,user_id uuid,status text, UNIQUE(id,user_id));
      CREATE TABLE documents(id uuid PRIMARY KEY,user_id uuid,source_inbox_item_id uuid,archived_at timestamptz,status text, UNIQUE(id,user_id));
      CREATE TABLE document_observations(id uuid,document_id uuid,user_id uuid,status text);
      CREATE TABLE document_archive_events(document_id uuid,archived boolean);
      CREATE FUNCTION set_document_archived(p_document_id uuid,p_archived boolean) RETURNS boolean LANGUAGE plpgsql AS $$
      BEGIN
        IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
        UPDATE documents SET archived_at = CASE WHEN p_archived THEN now() ELSE NULL END WHERE id=p_document_id AND user_id=auth.uid();
        IF NOT FOUND THEN RAISE EXCEPTION 'Document not found'; END IF;
        INSERT INTO document_archive_events VALUES (p_document_id,p_archived); RETURN p_archived;
      END; $$;
      INSERT INTO shortcut_inbox_items VALUES ('${email}','${owner}','pending');
      INSERT INTO documents VALUES ('${doc}','${owner}','${email}',NULL,'uploaded'),('${prior}','${owner}','${email}','2026-01-01','extracted');
    `);
    await db.exec(
      readFileSync('supabase/migrations/20261009000036_email_document_review.sql', 'utf8')
    );
    await db.exec(`SET request.jwt.claim.sub='${owner}'`);
    expect((await db.query('SELECT pending_document_count() AS count')).rows).toEqual([
      { count: 1 }
    ]);
    await db.exec(`UPDATE shortcut_inbox_items SET status='non_transaction' WHERE id='${email}'`);
    expect((await db.query(`SELECT archived_at FROM documents WHERE id='${doc}'`)).rows).toEqual([
      { archived_at: null }
    ]);
    await db.exec(`UPDATE shortcut_inbox_items SET status='dismissed' WHERE id='${email}'`);
    expect((await db.query('SELECT pending_document_count() AS count')).rows).toEqual([
      { count: 0 }
    ]);
    expect((await db.query('SELECT * FROM document_archive_events')).rows).toEqual([
      { document_id: doc, archived: true }
    ]);
    await db.exec(`UPDATE shortcut_inbox_items SET status='pending' WHERE id='${email}'`);
    expect((await db.query(`SELECT archived_at FROM documents WHERE id='${doc}'`)).rows).toEqual([
      { archived_at: null }
    ]);
    expect(
      (
        await db.query(
          `SELECT archived_at IS NOT NULL AS archived FROM documents WHERE id='${prior}'`
        )
      ).rows
    ).toEqual([{ archived: true }]);
    await db.exec(`UPDATE shortcut_inbox_items SET status='dismissed' WHERE id='${email}'`);
    await db.exec(`UPDATE documents SET archived_at='2026-02-01' WHERE id='${doc}'`);
    await db.exec(`UPDATE shortcut_inbox_items SET status='pending' WHERE id='${email}'`);
    expect(
      (
        await db.query(
          `SELECT archived_at='2026-02-01'::timestamptz AS preserved FROM documents WHERE id='${doc}'`
        )
      ).rows
    ).toEqual([{ preserved: true }]);
    await db.exec(`UPDATE documents SET archived_at=NULL WHERE id='${doc}'`);
    await db.exec(
      `CREATE OR REPLACE FUNCTION set_document_archived(p_document_id uuid,p_archived boolean) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic archive conflict'; END; $$`
    );
    await expect(
      db.exec(`UPDATE shortcut_inbox_items SET status='dismissed' WHERE id='${email}'`)
    ).rejects.toThrow(/archive conflict/i);
    expect(
      (await db.query(`SELECT status FROM shortcut_inbox_items WHERE id='${email}'`)).rows
    ).toEqual([{ status: 'pending' }]);
    await db.exec(`SET request.jwt.claim.sub='${stranger}'`);
    await expect(
      db.exec(`UPDATE shortcut_inbox_items SET status='dismissed' WHERE id='${email}'`)
    ).rejects.toThrow(/owner/i);
    expect(
      (await db.query(`SELECT status FROM shortcut_inbox_items WHERE id='${email}'`)).rows
    ).toEqual([{ status: 'pending' }]);
  } finally {
    await db.close();
  }
}, 30000);
