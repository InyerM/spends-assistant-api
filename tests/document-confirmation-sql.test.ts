import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260929000060_document_confirmation.sql'),
  'utf8'
);
const userA = '00000000-0000-4000-8000-000000000001';
const userB = '00000000-0000-4000-8000-000000000002';
const documentA = '10000000-0000-4000-8000-000000000001';
const observationA = '20000000-0000-4000-8000-000000000001';
const observationB = '20000000-0000-4000-8000-000000000002';
const transactionA = '30000000-0000-4000-8000-000000000001';
const transactionB = '30000000-0000-4000-8000-000000000002';

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE TABLE public.documents (
      id uuid PRIMARY KEY, user_id uuid NOT NULL, status text NOT NULL,
      processing_token uuid, model text, error_code text, document_type text
    );
    CREATE TABLE public.transactions (
      id uuid PRIMARY KEY, user_id uuid NOT NULL, amount numeric(15,2) NOT NULL,
      date date NOT NULL, description text NOT NULL, deleted_at timestamptz
    );
    CREATE TABLE public.document_observations (
      id uuid PRIMARY KEY, document_id uuid NOT NULL, user_id uuid NOT NULL,
      amount numeric(18,2), occurred_at_text text, description text NOT NULL,
      status text NOT NULL DEFAULT 'pending'
    );
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.documents TO authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_observations TO authenticated;
    INSERT INTO public.documents VALUES ('${documentA}', '${userA}', 'extracted');
    INSERT INTO public.document_observations VALUES
      ('${observationA}', '${documentA}', '${userA}', 1200, '2026-09-28', 'Receipt A', 'pending'),
      ('${observationB}', '${documentA}', '${userA}', 1200, '2026-09-28', 'Receipt B', 'pending');
    INSERT INTO public.transactions VALUES
      ('${transactionA}', '${userA}', 1200, '2026-09-29', 'Shop A', NULL),
      ('${transactionB}', '${userB}', 1200, '2026-09-29', 'Shop B', NULL);
  `);
  await db.exec(migration);
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

describe('document confirmation migration', () => {
  it('accepts once, returns the same decision for a retry, and leaves the transaction untouched', async () => {
    const db = await database();
    try {
      const call = `SELECT public.decide_document_observation('${observationA}', 'accept', '${transactionA}', '40000000-0000-4000-8000-000000000001') AS id`;
      const first = await asUser(db, userA, call);
      expect(await asUser(db, userA, call)).toEqual(first);
      expect(
        (
          await db.query(
            `SELECT status, match_transaction_id FROM document_observations WHERE id = '${observationA}'`
          )
        ).rows
      ).toEqual([{ status: 'confirmed', match_transaction_id: transactionA }]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM document_observation_decisions')).rows
      ).toEqual([{ count: 1 }]);
      expect(
        await asUser(db, userB, 'SELECT count(*)::int AS count FROM document_observation_decisions')
      ).toEqual([{ count: 0 }]);
      expect(
        (
          await db.query(
            "SELECT action, transaction_snapshot->>'amount' AS amount FROM document_observation_decisions"
          )
        ).rows
      ).toEqual([{ action: 'accept', amount: '1200.00' }]);
      expect(
        (
          await db.query(
            `SELECT amount, date::text, description FROM transactions WHERE id = '${transactionA}'`
          )
        ).rows
      ).toEqual([{ amount: '1200.00', date: '2026-09-29', description: 'Shop A' }]);
    } finally {
      await db.close();
    }
  });

  it('rejects cross-owner transactions and idempotency-key payload changes', async () => {
    const db = await database();
    try {
      await expect(
        asUser(
          db,
          userA,
          `SELECT public.decide_document_observation('${observationA}', 'accept', '${transactionB}', '40000000-0000-4000-8000-000000000002')`
        )
      ).rejects.toThrow();
      await expect(
        asUser(
          db,
          userB,
          `SELECT public.decide_document_observation('${observationA}', 'reject_observation', NULL, gen_random_uuid())`
        )
      ).rejects.toThrow();
      await asUser(
        db,
        userA,
        `SELECT public.decide_document_observation('${observationA}', 'accept', '${transactionA}', '40000000-0000-4000-8000-000000000003')`
      );
      await expect(
        asUser(
          db,
          userA,
          `SELECT public.decide_document_observation('${observationB}', 'accept', '${transactionA}', '40000000-0000-4000-8000-000000000003')`
        )
      ).rejects.toThrow();
      expect(
        (await db.query('SELECT count(*)::int AS count FROM document_observation_decisions')).rows
      ).toEqual([{ count: 1 }]);
    } finally {
      await db.close();
    }
  });

  it('refuses amount mismatch, dates outside three days, and reuse of a linked transaction', async () => {
    const db = await database();
    try {
      await db.exec(`UPDATE transactions SET amount = 1300 WHERE id = '${transactionA}'`);
      await expect(
        asUser(
          db,
          userA,
          `SELECT public.decide_document_observation('${observationA}', 'accept', '${transactionA}', gen_random_uuid())`
        )
      ).rejects.toThrow();
      await db.exec(
        `UPDATE transactions SET amount = 1200, date = '2026-10-04' WHERE id = '${transactionA}'`
      );
      await expect(
        asUser(
          db,
          userA,
          `SELECT public.decide_document_observation('${observationA}', 'accept', '${transactionA}', gen_random_uuid())`
        )
      ).rejects.toThrow();
      await db.exec(`UPDATE transactions SET date = '2026-09-29' WHERE id = '${transactionA}'`);
      await asUser(
        db,
        userA,
        `SELECT public.decide_document_observation('${observationA}', 'accept', '${transactionA}', gen_random_uuid())`
      );
      await expect(
        asUser(
          db,
          userA,
          `SELECT public.decide_document_observation('${observationB}', 'accept', '${transactionA}', gen_random_uuid())`
        )
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('audits explicit rejection and prevents authenticated direct mutation of the link or audit', async () => {
    const db = await database();
    try {
      await asUser(
        db,
        userA,
        `SELECT public.decide_document_observation('${observationA}', 'reject_observation', NULL, gen_random_uuid())`
      );
      expect(
        (
          await db.query(
            `SELECT status, match_transaction_id FROM document_observations WHERE id = '${observationA}'`
          )
        ).rows
      ).toEqual([{ status: 'rejected', match_transaction_id: null }]);
      await expect(
        asUser(
          db,
          userA,
          `UPDATE document_observations SET status = 'confirmed', match_transaction_id = '${transactionA}' WHERE id = '${observationA}'`
        )
      ).rejects.toThrow();
      await expect(
        asUser(db, userA, 'DELETE FROM document_observation_decisions')
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('rejects forged document state and allows only the current owner token to mark extraction failed', async () => {
    const db = await database();
    const tokenA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const tokenB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    try {
      await expect(
        asUser(
          db,
          userA,
          `INSERT INTO documents (id,user_id,status) VALUES (gen_random_uuid(),'${userA}','extracted')`
        )
      ).rejects.toThrow();
      await db.exec(
        `UPDATE documents SET status = 'processing', processing_token = '${tokenA}' WHERE id = '${documentA}'`
      );
      await expect(
        asUser(db, userA, `UPDATE documents SET status = 'extracted' WHERE id = '${documentA}'`)
      ).rejects.toThrow();
      expect(
        await asUser(
          db,
          userB,
          `SELECT public.fail_document_extraction('${documentA}', '${tokenA}', 'DOWNLOAD_FAILED') AS failed`
        )
      ).toEqual([{ failed: false }]);
      expect(
        await asUser(
          db,
          userA,
          `SELECT public.fail_document_extraction('${documentA}', '${tokenB}', 'DOWNLOAD_FAILED') AS failed`
        )
      ).toEqual([{ failed: false }]);
      expect(
        await asUser(
          db,
          userA,
          `SELECT public.fail_document_extraction('${documentA}', '${tokenA}', 'DOWNLOAD_FAILED') AS failed`
        )
      ).toEqual([{ failed: true }]);
      expect(
        (
          await db.query(
            `SELECT status, processing_token, error_code FROM documents WHERE id = '${documentA}'`
          )
        ).rows
      ).toEqual([{ status: 'failed', processing_token: null, error_code: 'DOWNLOAD_FAILED' }]);
    } finally {
      await db.close();
    }
  });

  it('keeps accepted links and decision rows immutable even for privileged table writes', async () => {
    const db = await database();
    try {
      await asUser(
        db,
        userA,
        `SELECT public.decide_document_observation('${observationA}', 'accept', '${transactionA}', gen_random_uuid())`
      );
      await expect(
        db.exec(
          `UPDATE document_observations SET match_transaction_id = NULL, status = 'pending' WHERE id = '${observationA}'`
        )
      ).rejects.toThrow();
      await expect(
        db.exec("UPDATE document_observation_decisions SET action = 'reject_observation'")
      ).rejects.toThrow();
      await expect(db.exec('DELETE FROM document_observation_decisions')).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});
