import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260929000060_document_confirmation.sql'),
  'utf8'
);
const inboxMigration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260929000010_document_inbox.sql'),
  'utf8'
);
const signedMigrationPath = join(
  process.cwd(),
  'supabase/migrations/20261001000000_signed_document_observations.sql'
);
const signedDecisionPath = join(
  process.cwd(),
  'supabase/migrations/20261001000010_signed_document_reconciliation.sql'
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
    CREATE SCHEMA storage;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE storage.buckets (
      id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL,
      file_size_limit bigint, allowed_mime_types text[]
    );
    CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
    CREATE FUNCTION storage.foldername(path text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
      SELECT string_to_array(path, '/')
    $$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.updated_at := now(); RETURN NEW; END;
    $$;
    CREATE TABLE public.transactions (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id), amount numeric(15,2) NOT NULL,
      date date NOT NULL, description text NOT NULL, deleted_at timestamptz,
      type text NOT NULL DEFAULT 'expense'
    );
    INSERT INTO auth.users VALUES ('${userA}'), ('${userB}');
    INSERT INTO public.transactions(id, user_id, amount, date, description, deleted_at) VALUES
      ('${transactionA}', '${userA}', 1200, '2026-09-29', 'Shop A', NULL),
      ('${transactionB}', '${userB}', 1200, '2026-09-29', 'Shop B', NULL);
  `);
  await db.exec(inboxMigration);
  await db.exec(`
    INSERT INTO public.documents (id, user_id, file_name, file_path, mime_type, sha256, status)
      VALUES ('${documentA}', '${userA}', 'receipt.png', '${userA}/receipt.png', 'image/png',
        '${'a'.repeat(64)}', 'extracted');
    INSERT INTO public.document_observations
      (id, document_id, user_id, ordinal, amount, occurred_at_text, description, source_excerpt, confidence)
      VALUES
      ('${observationA}', '${documentA}', '${userA}', 0, 1200, '2026-09-28', 'Receipt A', 'Receipt A', 0.9),
      ('${observationB}', '${documentA}', '${userA}', 1, 1200, '2026-09-28', 'Receipt B', 'Receipt B', 0.9);
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
  it('rejects mismatched and unknown currencies while preserving ledger state and idempotence', async () => {
    const db = await database();
    try {
      await db.exec(`
        CREATE TABLE public.accounts(id uuid PRIMARY KEY, user_id uuid NOT NULL, currency text);
        ALTER TABLE public.transactions ADD COLUMN account_id uuid, ADD COLUMN currency text;
        INSERT INTO public.accounts VALUES ('50000000-0000-4000-8000-000000000001', '${userA}', 'COP');
        UPDATE public.transactions SET account_id = '50000000-0000-4000-8000-000000000001', currency = 'USD' WHERE id = '${transactionA}';
        UPDATE public.document_observations SET currency = 'COP' WHERE id = '${observationA}';
      `);
      await db.exec(
        readFileSync(
          join(
            process.cwd(),
            'supabase/migrations/20261008000021_document_reconciliation_currency.sql'
          ),
          'utf8'
        )
      );
      const call = `SELECT public.decide_document_observation('${observationA}', 'accept', '${transactionA}', '40000000-0000-4000-8000-000000000099') AS id`;
      await expect(asUser(db, userA, call)).rejects.toThrow(/Currencies do not match/);
      await db.exec(`UPDATE public.transactions SET currency = NULL WHERE id = '${transactionA}'`);
      await expect(asUser(db, userA, call)).rejects.toThrow(/Currencies do not match/);
      await db.exec(
        `UPDATE public.transactions SET currency = 'COP' WHERE id = '${transactionA}'; UPDATE public.document_observations SET currency = NULL WHERE id = '${observationA}'`
      );
      await expect(asUser(db, userA, call)).rejects.toThrow(/Currencies do not match/);
      await db.exec(
        `UPDATE public.document_observations SET currency = 'COP' WHERE id = '${observationA}'`
      );
      const before = (await db.query(`SELECT * FROM transactions ORDER BY id`)).rows;
      const result = await asUser(db, userA, call);
      expect(await asUser(db, userA, call)).toEqual(result);
      expect((await db.query(`SELECT * FROM transactions ORDER BY id`)).rows).toEqual(before);
      expect(
        (await db.query(`SELECT count(*)::int AS count FROM document_observation_decisions`)).rows
      ).toEqual([{ count: 1 }]);
      expect(
        (await db.query(`SELECT transaction_snapshot FROM document_observation_decisions`)).rows[0]
      ).toMatchObject({
        transaction_snapshot: {
          currency: 'COP',
          type: 'expense',
          account_id: '50000000-0000-4000-8000-000000000001'
        }
      });
    } finally {
      await db.close();
    }
  });

  it('confirms a negative bank debit against a positive expense without changing the observation sign', async () => {
    const db = await database();
    const signedObservation = '20000000-0000-4000-8000-000000000003';
    try {
      await db.exec(readFileSync(signedMigrationPath, 'utf8'));
      await db.exec(readFileSync(signedDecisionPath, 'utf8'));
      await db.exec(`
        INSERT INTO public.document_observations
          (id, document_id, user_id, ordinal, amount, occurred_at_text, description, source_excerpt, confidence)
        VALUES ('${signedObservation}', '${documentA}', '${userA}', 2, -1200, '2026-09-29',
          'Bank debit', 'Bank debit', 0.9)
      `);
      await asUser(
        db,
        userA,
        `SELECT public.decide_document_observation('${signedObservation}', 'accept', '${transactionA}', gen_random_uuid())`
      );
      expect(
        (
          await db.query(
            `SELECT amount, status FROM document_observations WHERE id = '${signedObservation}'`
          )
        ).rows
      ).toEqual([{ amount: '-1200.00', status: 'confirmed' }]);
      const incomeId = '30000000-0000-4000-8000-000000000003';
      const secondObservation = '20000000-0000-4000-8000-000000000004';
      await db.exec(`
        INSERT INTO public.transactions(id, user_id, amount, date, description, type)
          VALUES ('${incomeId}', '${userA}', 1200, '2026-09-29', 'Incoming transfer', 'income');
        INSERT INTO public.document_observations
          (id, document_id, user_id, ordinal, amount, occurred_at_text, description, source_excerpt, confidence)
          VALUES ('${secondObservation}', '${documentA}', '${userA}', 3, -1200, '2026-09-29',
            'Bank debit', 'Bank debit', 0.9);
      `);
      await expect(
        asUser(
          db,
          userA,
          `SELECT public.decide_document_observation('${secondObservation}', 'accept', '${incomeId}', gen_random_uuid())`
        )
      ).rejects.toThrow(/Signed bank debit cannot match an income/);
    } finally {
      await db.close();
    }
  });
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

  it('deletes reviewed evidence when its document is erased', async () => {
    const db = await database();
    try {
      await asUser(
        db,
        userA,
        `SELECT public.decide_document_observation('${observationA}', 'accept', '${transactionA}', gen_random_uuid())`
      );
      await asUser(
        db,
        userA,
        `SELECT public.decide_document_observation('${observationB}', 'reject_observation', NULL, gen_random_uuid())`
      );
      await db.exec(`DELETE FROM documents WHERE id = '${documentA}'`);
      expect(
        (
          await db.query(
            `SELECT count(*)::int AS count FROM document_observations WHERE document_id = '${documentA}'`
          )
        ).rows
      ).toEqual([{ count: 0 }]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM document_observation_decisions')).rows
      ).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });

  it('erases reviewed evidence when the linked transaction is hard deleted', async () => {
    const db = await database();
    try {
      await asUser(
        db,
        userA,
        `SELECT public.decide_document_observation('${observationA}', 'accept', '${transactionA}', gen_random_uuid())`
      );
      await db.exec(`DELETE FROM transactions WHERE id = '${transactionA}'`);
      expect(
        (await db.query(`SELECT count(*)::int AS count FROM documents WHERE id = '${documentA}'`))
          .rows
      ).toEqual([{ count: 1 }]);
      expect(
        (
          await db.query(
            `SELECT count(*)::int AS count FROM document_observations WHERE id = '${observationA}'`
          )
        ).rows
      ).toEqual([{ count: 0 }]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM document_observation_decisions')).rows
      ).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });

  it('allows account erasure after legacy transaction cleanup and retains another owner', async () => {
    const db = await database();
    try {
      await asUser(
        db,
        userA,
        `SELECT public.decide_document_observation('${observationA}', 'accept', '${transactionA}', gen_random_uuid())`
      );
      // The existing transactions.user_id FK is NO ACTION, so user deletion
      // requires transaction cleanup independently of document review.
      await expect(db.exec(`DELETE FROM auth.users WHERE id = '${userA}'`)).rejects.toThrow();
      await db.exec(`DELETE FROM transactions WHERE user_id = '${userA}'`);
      await db.exec(`DELETE FROM auth.users WHERE id = '${userA}'`);
      expect((await db.query('SELECT count(*)::int AS count FROM documents')).rows).toEqual([
        { count: 0 }
      ]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM document_observations')).rows
      ).toEqual([{ count: 0 }]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM document_observation_decisions')).rows
      ).toEqual([{ count: 0 }]);
      expect(
        (await db.query(`SELECT count(*)::int AS count FROM auth.users WHERE id = '${userB}'`)).rows
      ).toEqual([{ count: 1 }]);
    } finally {
      await db.close();
    }
  });
});
