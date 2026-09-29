import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const inboxMigration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260929000030_shortcut_inbox.sql'),
  'utf8'
);
const matchMigration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260929000080_shortcut_match_ack.sql'),
  'utf8'
);
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const inboxA = '10000000-0000-4000-8000-000000000001';
const inboxB = '10000000-0000-4000-8000-000000000002';
const inboxOther = '10000000-0000-4000-8000-000000000003';
const transactionA = '20000000-0000-4000-8000-000000000001';
const transactionB = '20000000-0000-4000-8000-000000000002';
const transactionOther = '20000000-0000-4000-8000-000000000003';

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE ROLE anon;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
    CREATE TABLE public.transactions (
      id uuid PRIMARY KEY, user_id uuid NOT NULL, amount numeric(15,2) NOT NULL,
      date date NOT NULL, description text NOT NULL, account_id uuid NOT NULL,
      type text NOT NULL, source text NOT NULL, deleted_at timestamptz,
      CONSTRAINT transactions_id_user_unique UNIQUE (id, user_id)
    );
    INSERT INTO auth.users VALUES ('${owner}'), ('${other}');
  `);
  await db.exec(inboxMigration);
  await db.exec(`
    INSERT INTO public.shortcut_inbox_items
      (id,user_id,source,received_at,raw_text,idempotency_key,status) VALUES
      ('${inboxA}','${owner}','sms-shortcut','2026-09-28T10:00:00Z','Synthetic payment A',repeat('a',64),'pending'),
      ('${inboxB}','${owner}','sms-shortcut','2026-09-28T11:00:00Z','Synthetic payment B',repeat('b',64),'pending'),
      ('${inboxOther}','${other}','sms-shortcut','2026-09-28T12:00:00Z','Synthetic payment C',repeat('c',64),'pending');
    INSERT INTO public.transactions VALUES
      ('${transactionA}','${owner}',1200,'2026-09-28','Synthetic purchase A',gen_random_uuid(),'expense','web',NULL),
      ('${transactionB}','${owner}',1200,'2026-09-28','Synthetic purchase B',gen_random_uuid(),'expense','web','2026-09-29'),
      ('${transactionOther}','${other}',1200,'2026-09-28','Other owner purchase',gen_random_uuid(),'expense','web',NULL);
  `);
  await db.exec(matchMigration);
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

const acknowledge = (inboxId: string, transactionId: string): string =>
  `SELECT public.acknowledge_shortcut_match('${inboxId}', '${transactionId}') AS id`;

describe('Shortcut existing-transaction acknowledgement migration', () => {
  it('acknowledges an owned active transaction once and returns the same audit ID on retry', async () => {
    const db = await database();
    try {
      const first = await asUser(db, owner, acknowledge(inboxA, transactionA));
      expect(await asUser(db, owner, acknowledge(inboxA, transactionA))).toEqual(first);
      expect(
        (await db.query(`SELECT status FROM public.shortcut_inbox_items WHERE id = '${inboxA}'`))
          .rows
      ).toEqual([{ status: 'matched' }]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.shortcut_inbox_match_decisions'))
          .rows
      ).toEqual([{ count: 1 }]);
      expect(
        (
          await db.query(
            `SELECT amount, date::text, description, deleted_at FROM public.transactions WHERE id = '${transactionA}'`
          )
        ).rows
      ).toEqual([
        {
          amount: '1200.00',
          date: '2026-09-28',
          description: 'Synthetic purchase A',
          deleted_at: null
        }
      ]);
      expect(
        (
          await db.query(
            "SELECT transaction_snapshot->>'amount' AS amount FROM public.shortcut_inbox_match_decisions"
          )
        ).rows
      ).toEqual([{ amount: '1200.00' }]);
    } finally {
      await db.close();
    }
  });

  it('rejects cross-owner inbox and transaction IDs, deleted transactions, and nonpending items', async () => {
    const db = await database();
    try {
      await expect(asUser(db, owner, acknowledge(inboxOther, transactionA))).rejects.toThrow();
      await expect(asUser(db, owner, acknowledge(inboxA, transactionOther))).rejects.toThrow();
      await expect(asUser(db, owner, acknowledge(inboxA, transactionB))).rejects.toThrow();
      await db.exec(
        `UPDATE public.shortcut_inbox_items SET status = 'dismissed' WHERE id = '${inboxA}'`
      );
      await expect(asUser(db, owner, acknowledge(inboxA, transactionA))).rejects.toThrow();
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.shortcut_inbox_match_decisions'))
          .rows
      ).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });

  it('rejects a competing choice for one inbox item but permits a second reviewed notification for the same transaction', async () => {
    const db = await database();
    try {
      await asUser(db, owner, acknowledge(inboxA, transactionA));
      await db.exec(
        `UPDATE public.transactions SET deleted_at = NULL WHERE id = '${transactionB}'`
      );
      await expect(asUser(db, owner, acknowledge(inboxA, transactionB))).rejects.toThrow();
      await asUser(db, owner, acknowledge(inboxB, transactionA));
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.shortcut_inbox_match_decisions'))
          .rows
      ).toEqual([{ count: 2 }]);
    } finally {
      await db.close();
    }
  });

  it('lets a hard transaction delete erase decisions and return linked inbox items to pending', async () => {
    const db = await database();
    try {
      await asUser(db, owner, acknowledge(inboxA, transactionA));
      await asUser(db, owner, acknowledge(inboxB, transactionA));
      await db.exec(`DELETE FROM public.transactions WHERE id = '${transactionA}'`);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.shortcut_inbox_match_decisions'))
          .rows
      ).toEqual([{ count: 0 }]);
      expect(
        (
          await db.query(
            `SELECT id, status FROM public.shortcut_inbox_items WHERE id IN ('${inboxA}','${inboxB}') ORDER BY id`
          )
        ).rows
      ).toEqual([
        { id: inboxA, status: 'pending' },
        { id: inboxB, status: 'pending' }
      ]);
    } finally {
      await db.close();
    }
  });

  it('lets inbox erasure cascade to its decision without orphaning audit rows', async () => {
    const db = await database();
    try {
      await asUser(db, owner, acknowledge(inboxA, transactionA));
      await db.exec(`DELETE FROM public.shortcut_inbox_items WHERE id = '${inboxA}'`);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.shortcut_inbox_match_decisions'))
          .rows
      ).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });

  it('keeps the audit and matched status immutable and visible only to the owner', async () => {
    const db = await database();
    try {
      await expect(
        asUser(
          db,
          owner,
          `UPDATE public.shortcut_inbox_items SET status = 'matched' WHERE id = '${inboxA}'`
        )
      ).rejects.toThrow();
      await asUser(db, owner, acknowledge(inboxA, transactionA));
      await expect(
        asUser(
          db,
          owner,
          `UPDATE public.shortcut_inbox_items SET status = 'pending' WHERE id = '${inboxA}'`
        )
      ).rejects.toThrow();
      await expect(
        asUser(db, owner, 'DELETE FROM public.shortcut_inbox_match_decisions')
      ).rejects.toThrow();
      await expect(
        asUser(
          db,
          owner,
          'UPDATE public.shortcut_inbox_match_decisions SET transaction_id = gen_random_uuid()'
        )
      ).rejects.toThrow();
      expect(
        await asUser(
          db,
          other,
          'SELECT count(*)::int AS count FROM public.shortcut_inbox_match_decisions'
        )
      ).toEqual([{ count: 0 }]);
      expect(
        await asUser(
          db,
          owner,
          'SELECT count(*)::int AS count FROM public.shortcut_inbox_match_decisions'
        )
      ).toEqual([{ count: 1 }]);
    } finally {
      await db.close();
    }
  });
});
