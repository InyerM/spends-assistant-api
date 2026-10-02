import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const migration = (name: string): string =>
  readFileSync(join(process.cwd(), `supabase/migrations/${name}`), 'utf8');
const owner = '00000000-0000-4000-8000-000000000001';
const stranger = '00000000-0000-4000-8000-000000000002';
const documentId = '10000000-0000-4000-8000-000000000001';
const observationId = '20000000-0000-4000-8000-000000000001';

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE ROLE anon;
    CREATE SCHEMA auth;
    CREATE SCHEMA storage;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
    CREATE FUNCTION storage.foldername(path text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(path, '/') $$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.updated_at := now(); RETURN NEW; END;
    $$;
    CREATE TABLE public.transactions (id uuid PRIMARY KEY, user_id uuid, amount numeric(15,2), date date, description text, deleted_at timestamptz, type text, source text, parsed_data jsonb);
    INSERT INTO auth.users VALUES ('${owner}'), ('${stranger}');
  `);
  for (const name of [
    '20260929000010_document_inbox.sql',
    '20261001000000_signed_document_observations.sql'
  ])
    await db.exec(migration(name));
  await db.exec(`
    INSERT INTO documents(id,user_id,file_name,file_path,mime_type,sha256,status)
    VALUES ('${documentId}','${owner}','bank.png','${owner}/bank.png','image/png','${'a'.repeat(64)}','extracted');
    INSERT INTO document_observations(id,document_id,user_id,ordinal,amount,currency,occurred_at_text,description,source_excerpt,confidence)
    VALUES ('${observationId}','${documentId}','${owner}',0,-12000,'COP','2026-09-28','Lunch','Lunch $12000',0.95);
  `);
  for (const name of [
    '20260929000060_document_confirmation.sql',
    '20261001000010_signed_document_reconciliation.sql',
    '20261001000040_document_observation_review.sql',
    '20261002000000_document_review_lifecycle.sql'
  ])
    await db.exec(migration(name));
  return db;
}

async function asUser(db: PGlite, userId: string, sql: string): Promise<unknown[]> {
  await db.exec(`SET request.jwt.claim.sub = '${userId}'; SET ROLE authenticated;`);
  try {
    return (await db.query(sql)).rows;
  } finally {
    await db.exec('RESET ROLE;');
  }
}

describe('document review lifecycle', () => {
  it('records a preset rejection reason and restores the draft with an audit event', async () => {
    const db = await database();
    try {
      await asUser(
        db,
        owner,
        `SELECT decide_document_observation_with_reason('${observationId}', 'reject_observation', NULL, gen_random_uuid(), 'already_recorded')`
      );
      expect(
        (await db.query(`SELECT status FROM document_observations WHERE id='${observationId}'`))
          .rows
      ).toEqual([{ status: 'rejected' }]);
      expect(
        (await db.query('SELECT reason FROM document_observation_rejection_reasons')).rows
      ).toEqual([{ reason: 'already_recorded' }]);
      await asUser(db, owner, `SELECT restore_document_observation('${observationId}')`);
      expect(
        (await db.query(`SELECT status FROM document_observations WHERE id='${observationId}'`))
          .rows
      ).toEqual([{ status: 'pending' }]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM document_observation_restorations'))
          .rows
      ).toEqual([{ count: 1 }]);
    } finally {
      await db.close();
    }
  });

  it('blocks unknown reasons, foreign restoration, and direct status edits', async () => {
    const db = await database();
    try {
      await expect(
        asUser(
          db,
          owner,
          `SELECT decide_document_observation_with_reason('${observationId}', 'reject_observation', NULL, gen_random_uuid(), 'invented')`
        )
      ).rejects.toThrow(/reason/i);
      await asUser(
        db,
        owner,
        `SELECT decide_document_observation_with_reason('${observationId}', 'reject_observation', NULL, gen_random_uuid(), 'not_a_transaction')`
      );
      await expect(
        asUser(db, stranger, `SELECT restore_document_observation('${observationId}')`)
      ).rejects.toThrow(/not found/i);
      await expect(
        asUser(
          db,
          owner,
          `UPDATE document_observations SET status='pending' WHERE id='${observationId}'`
        )
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('archives and restores the owner capture without deleting observations', async () => {
    const db = await database();
    try {
      await asUser(db, owner, `SELECT set_document_archived('${documentId}', true)`);
      expect(
        (
          await db.query(
            `SELECT archived_at IS NOT NULL AS archived FROM documents WHERE id='${documentId}'`
          )
        ).rows
      ).toEqual([{ archived: true }]);
      await expect(
        asUser(db, stranger, `SELECT set_document_archived('${documentId}', false)`)
      ).rejects.toThrow(/not found/i);
      await asUser(db, owner, `SELECT set_document_archived('${documentId}', false)`);
      expect(
        (
          await db.query(
            `SELECT archived_at IS NOT NULL AS archived FROM documents WHERE id='${documentId}'`
          )
        ).rows
      ).toEqual([{ archived: false }]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM document_observations')).rows
      ).toEqual([{ count: 1 }]);
    } finally {
      await db.close();
    }
  });

  it('keeps a capture visible while a created transaction still needs its observation link', async () => {
    const db = await database();
    try {
      await db.exec(`INSERT INTO transactions(id,user_id,amount,date,description,type,source,parsed_data)
        VALUES ('30000000-0000-4000-8000-000000000002','${owner}',12000,'2026-09-28','Lunch','expense','web-document',
        '{"document_id":"${documentId}","observation_id":"${observationId}"}'::jsonb)`);
      await expect(
        asUser(db, owner, `SELECT set_document_archived('${documentId}', true)`)
      ).rejects.toThrow(/created transaction/i);
      expect(
        (
          await db.query(
            `SELECT archived_at IS NULL AS active FROM documents WHERE id='${documentId}'`
          )
        ).rows
      ).toEqual([{ active: true }]);
    } finally {
      await db.close();
    }
  });

  it('prevents review decisions while the capture is archived', async () => {
    const db = await database();
    try {
      await asUser(db, owner, `SELECT set_document_archived('${documentId}', true)`);
      await expect(
        asUser(
          db,
          owner,
          `SELECT decide_document_observation('${observationId}', 'reject_observation', NULL, gen_random_uuid())`
        )
      ).rejects.toThrow(/archived/i);
    } finally {
      await db.close();
    }
  });
});
