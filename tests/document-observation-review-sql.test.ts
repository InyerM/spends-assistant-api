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
  await db.exec(migration('20260929000010_document_inbox.sql'));
  await db.exec(migration('20261001000000_signed_document_observations.sql'));
  await db.exec(`
    INSERT INTO documents(id,user_id,file_name,file_path,mime_type,sha256,status)
    VALUES ('${documentId}','${owner}','bank.png','${owner}/bank.png','image/png','${'a'.repeat(64)}','extracted');
    INSERT INTO document_observations(id,document_id,user_id,ordinal,amount,currency,occurred_at_text,description,source_excerpt,confidence)
    VALUES ('${observationId}','${documentId}','${owner}',0,-12000,'USD','2026-09-28','Lunch','Lunch $12000',0.95);
  `);
  await db.exec(migration('20260929000060_document_confirmation.sql'));
  await db.exec(migration('20261001000010_signed_document_reconciliation.sql'));
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

describe('document observation review corrections', () => {
  it('lets the owner correct an ambiguous currency and retains the original OCR value', async () => {
    const db = await database();
    try {
      await db.exec(migration('20261001000040_document_observation_review.sql'));
      await asUser(
        db,
        owner,
        `SELECT revise_document_observation('${observationId}', -12000, 'COP', '2026-09-28', 'Lunch')`
      );
      expect(
        (
          await db.query(
            `SELECT currency, extracted_snapshot->>'currency' AS original_currency, reviewed_at IS NOT NULL AS reviewed FROM document_observations WHERE id = '${observationId}'`
          )
        ).rows
      ).toEqual([{ currency: 'COP', original_currency: 'USD', reviewed: true }]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM document_observation_edits')).rows
      ).toEqual([{ count: 1 }]);
      await expect(
        asUser(
          db,
          stranger,
          `SELECT revise_document_observation('${observationId}', -12000, 'USD', '2026-09-28', 'Lunch')`
        )
      ).rejects.toThrow(/not found/i);
      expect(
        (await db.query(`SELECT currency FROM document_observations WHERE id = '${observationId}'`))
          .rows
      ).toEqual([{ currency: 'COP' }]);
    } finally {
      await db.close();
    }
  });

  it('rejects invalid amounts and edits after a final review decision', async () => {
    const db = await database();
    try {
      await db.exec(migration('20261001000040_document_observation_review.sql'));
      await expect(
        asUser(
          db,
          owner,
          `SELECT revise_document_observation('${observationId}', 0, 'COP', '2026-09-28', 'Lunch')`
        )
      ).rejects.toThrow(/amount/i);
      await expect(
        asUser(
          db,
          owner,
          `SELECT revise_document_observation('${observationId}', -12000, 'US', '2026-09-28', 'Lunch')`
        )
      ).rejects.toThrow(/currency/i);
      await db.exec(
        `UPDATE document_observations SET status = 'rejected' WHERE id = '${observationId}'`
      );
      await expect(
        asUser(
          db,
          owner,
          `SELECT revise_document_observation('${observationId}', -12000, 'COP', '2026-09-28', 'Lunch')`
        )
      ).rejects.toThrow(/pending/i);
    } finally {
      await db.close();
    }
  });

  it('matches a transaction against the reviewed amount and date', async () => {
    const db = await database();
    try {
      await db.exec(migration('20261001000040_document_observation_review.sql'));
      await asUser(
        db,
        owner,
        `SELECT revise_document_observation('${observationId}', -13000, 'COP', '2026-09-29', 'Lunch corrected')`
      );
      const transactionId = '30000000-0000-4000-8000-000000000001';
      await db.exec(`INSERT INTO transactions(id,user_id,amount,date,description,type)
        VALUES ('${transactionId}','${owner}',13000,'2026-09-29','Lunch corrected','expense')`);
      await asUser(
        db,
        owner,
        `SELECT decide_document_observation('${observationId}', 'accept', '${transactionId}', gen_random_uuid())`
      );
      expect(
        (
          await db.query(
            `SELECT status, match_transaction_id FROM document_observations WHERE id = '${observationId}'`
          )
        ).rows
      ).toEqual([{ status: 'confirmed', match_transaction_id: transactionId }]);
    } finally {
      await db.close();
    }
  });

  it('does not reject an observation after its transaction was created but not linked', async () => {
    const db = await database();
    try {
      await db.exec(migration('20261001000040_document_observation_review.sql'));
      await db.exec(`INSERT INTO transactions(id,user_id,amount,date,description,type,source,parsed_data)
        VALUES ('30000000-0000-4000-8000-000000000002','${owner}',12000,'2026-09-28','Lunch','expense','web-document',
        '{"document_id":"${documentId}","observation_id":"${observationId}"}'::jsonb)`);
      await expect(
        asUser(
          db,
          owner,
          `SELECT decide_document_observation('${observationId}','reject_observation',NULL,'40000000-0000-4000-8000-000000000002')`
        )
      ).rejects.toThrow(/created transaction/i);
    } finally {
      await db.close();
    }
  });
});
