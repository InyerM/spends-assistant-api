import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const migration = (name: string): string =>
  readFileSync(join(process.cwd(), `supabase/migrations/${name}`), 'utf8');
const owner = '00000000-0000-4000-8000-000000000001';
const stranger = '00000000-0000-4000-8000-000000000002';
const documentId = '10000000-0000-4000-8000-000000000001';
const staleToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
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
    CREATE TABLE public.transactions (id uuid PRIMARY KEY, user_id uuid, amount numeric(15,2), date date, description text, deleted_at timestamptz);
    INSERT INTO auth.users VALUES ('${owner}'), ('${stranger}');
  `);
  await db.exec(migration('20260929000010_document_inbox.sql'));
  await db.exec(migration('20260929000060_document_confirmation.sql'));
  await db.exec(`
    INSERT INTO documents (id,user_id,file_name,file_path,mime_type,sha256)
    VALUES ('${documentId}','${owner}','receipt.png','${owner}/receipt.png','image/png','${'a'.repeat(64)}');
  `);
  await db.exec(migration('20260929000070_document_provenance.sql'));
  return db;
}

async function asRole(
  db: PGlite,
  role: 'authenticated' | 'service_role',
  jwtUser: string,
  sql: string
): Promise<unknown[]> {
  await db.exec(`SET request.jwt.claim.sub = '${jwtUser}'; SET ROLE ${role};`);
  try {
    return (await db.query(sql)).rows;
  } finally {
    await db.exec('RESET ROLE;');
  }
}

async function claim(db: PGlite): Promise<string> {
  const rows = await asRole(
    db,
    'authenticated',
    owner,
    `SELECT claim_document_extraction('${documentId}') AS token`
  );
  return (rows[0] as { token: string }).token;
}

const observation = JSON.stringify([
  {
    ordinal: 0,
    amount: 1200,
    currency: 'COP',
    occurred_at_text: '2026-09-28',
    description: 'Coffee',
    counterparty: null,
    reference: null,
    source_excerpt: 'Coffee 1200',
    confidence: 0.9
  }
]);

function completion(token: string, ownerId = owner): string {
  return `SELECT complete_document_extraction_server('${documentId}','${ownerId}','${token}','receipt','qwen','${observation}'::jsonb) AS count`;
}

describe('server-only document extraction persistence', () => {
  it('persists signed movements while still rejecting zero-value observations', async () => {
    const db = await database();
    try {
      await db.exec(migration('20261001000000_signed_document_observations.sql'));
      const token = await claim(db);
      const signed = observation.replace('"amount":1200', '"amount":-1200');
      const sql = `SELECT complete_document_extraction_server('${documentId}','${owner}','${token}','bank_screenshot','qwen','${signed}'::jsonb) AS count`;
      expect(await asRole(db, 'service_role', owner, sql)).toEqual([{ count: 1 }]);
      expect((await db.query('SELECT amount FROM document_observations')).rows).toEqual([
        { amount: '-1200.00' }
      ]);
      await expect(
        db.exec(`UPDATE document_observations SET amount = 0 WHERE document_id = '${documentId}'`)
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
  it('denies authenticated callers both old completion and server completion', async () => {
    const db = await database();
    try {
      const token = await claim(db);
      await expect(
        asRole(
          db,
          'authenticated',
          owner,
          `SELECT complete_document_extraction('${documentId}','${token}','receipt','qwen','${observation}'::jsonb)`
        )
      ).rejects.toThrow();
      await expect(
        asRole(
          db,
          'service_role',
          owner,
          `SELECT complete_document_extraction('${documentId}','${token}','receipt','qwen','${observation}'::jsonb)`
        )
      ).rejects.toThrow();
      await expect(asRole(db, 'authenticated', owner, completion(token))).rejects.toThrow();
      expect(
        (await db.query(`SELECT status FROM documents WHERE id = '${documentId}'`)).rows
      ).toEqual([{ status: 'processing' }]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM document_observations')).rows
      ).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });

  it('lets only service_role complete the claimed owner document atomically, independent of JWT context', async () => {
    const db = await database();
    try {
      const token = await claim(db);
      expect(await asRole(db, 'service_role', stranger, completion(token))).toEqual([{ count: 1 }]);
      expect(
        (
          await db.query(
            `SELECT status, processing_token, model FROM documents WHERE id = '${documentId}'`
          )
        ).rows
      ).toEqual([{ status: 'extracted', processing_token: null, model: 'qwen' }]);
      expect(
        (await db.query('SELECT user_id, status, amount FROM document_observations')).rows
      ).toEqual([{ user_id: owner, status: 'pending', amount: '1200.00' }]);
    } finally {
      await db.close();
    }
  });

  it('rejects mismatched owner and stale claim tokens without persisting drafts', async () => {
    const db = await database();
    try {
      const token = await claim(db);
      await expect(
        asRole(db, 'service_role', owner, completion(token, stranger))
      ).rejects.toThrow();
      await expect(asRole(db, 'service_role', owner, completion(staleToken))).rejects.toThrow();
      expect(
        (
          await db.query(
            `SELECT status, processing_token FROM documents WHERE id = '${documentId}'`
          )
        ).rows
      ).toEqual([{ status: 'processing', processing_token: token }]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM document_observations')).rows
      ).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });

  it('denies authenticated failure and only lets service_role fail the current owner claim', async () => {
    const db = await database();
    try {
      const token = await claim(db);
      await expect(
        asRole(
          db,
          'authenticated',
          owner,
          `SELECT fail_document_extraction('${documentId}','${token}','DOWNLOAD_FAILED')`
        )
      ).rejects.toThrow();
      await expect(
        asRole(
          db,
          'authenticated',
          owner,
          `SELECT fail_document_extraction_server('${documentId}','${owner}','${token}','DOWNLOAD_FAILED')`
        )
      ).rejects.toThrow();
      expect(
        await asRole(
          db,
          'service_role',
          stranger,
          `SELECT fail_document_extraction_server('${documentId}','${stranger}','${token}','DOWNLOAD_FAILED') AS failed`
        )
      ).toEqual([{ failed: false }]);
      expect(
        await asRole(
          db,
          'service_role',
          stranger,
          `SELECT fail_document_extraction_server('${documentId}','${owner}','${staleToken}','DOWNLOAD_FAILED') AS failed`
        )
      ).toEqual([{ failed: false }]);
      expect(
        await asRole(
          db,
          'service_role',
          stranger,
          `SELECT fail_document_extraction_server('${documentId}','${owner}','${token}','DOWNLOAD_FAILED') AS failed`
        )
      ).toEqual([{ failed: true }]);
      expect(
        (
          await db.query(
            `SELECT status, processing_token, error_code FROM documents WHERE id = '${documentId}'`
          )
        ).rows
      ).toEqual([{ status: 'failed', processing_token: null, error_code: 'DOWNLOAD_FAILED' }]);
    } finally {
      await db.close();
    }
  });
});
