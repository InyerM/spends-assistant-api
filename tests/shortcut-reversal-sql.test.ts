import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const migration = (name: string): string =>
  readFileSync(join(process.cwd(), `supabase/migrations/${name}.sql`), 'utf8');
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const inbox = '10000000-0000-4000-8000-000000000001';
const otherInbox = '10000000-0000-4000-8000-000000000002';
const account = '20000000-0000-4000-8000-000000000001';
const category = '30000000-0000-4000-8000-000000000001';
const transactionA = '40000000-0000-4000-8000-000000000001';
const transactionB = '40000000-0000-4000-8000-000000000002';

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE anon;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
    CREATE TABLE public.accounts(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      balance numeric(15,2), is_active boolean DEFAULT true, deleted_at timestamptz);
    CREATE TABLE public.categories(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      type text NOT NULL, is_active boolean DEFAULT true, deleted_at timestamptz);
    CREATE TABLE public.transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL, amount numeric(15,2) NOT NULL, date date NOT NULL,
      time time NOT NULL, description text NOT NULL, account_id uuid NOT NULL,
      category_id uuid, type text NOT NULL, source text NOT NULL, raw_text text,
      parsed_data jsonb, deleted_at timestamptz,
      CONSTRAINT transactions_id_user_unique UNIQUE(id,user_id));
    CREATE TABLE public.usage_tracking(user_id uuid NOT NULL, month text NOT NULL,
      transactions_count integer NOT NULL DEFAULT 0, updated_at timestamptz DEFAULT now(),
      PRIMARY KEY(user_id,month));
    CREATE TABLE public.subscriptions(user_id uuid PRIMARY KEY, plan text NOT NULL,
      status text NOT NULL DEFAULT 'active');
    CREATE TABLE public.app_settings(key text PRIMARY KEY, value jsonb NOT NULL);
    INSERT INTO auth.users VALUES('${owner}'),('${other}');
    INSERT INTO public.accounts VALUES('${account}','${owner}',10000,true,NULL);
    INSERT INTO public.categories VALUES('${category}','${owner}','expense',true,NULL);
    INSERT INTO public.subscriptions VALUES('${owner}','free');
    INSERT INTO public.app_settings VALUES('free_transactions_limit','50');
  `);
  await db.exec(migration('20260929000030_shortcut_inbox'));
  await db.exec(`
    INSERT INTO public.shortcut_inbox_items
      (id,user_id,source,received_at,raw_text,idempotency_key) VALUES
      ('${inbox}','${owner}','sms-shortcut','2026-09-28T10:00:00Z','Synthetic receipt',repeat('a',64)),
      ('${otherInbox}','${other}','sms-shortcut','2026-09-28T10:00:00Z','Other receipt',repeat('b',64));
    INSERT INTO public.transactions(id,user_id,amount,date,time,description,account_id,
      category_id,type,source) VALUES
      ('${transactionA}','${owner}',1200,'2026-09-28','10:00','First',
        '${account}','${category}','expense','web'),
      ('${transactionB}','${owner}',1300,'2026-09-28','10:00','Second',
        '${account}','${category}','expense','web');
  `);
  await db.exec(migration('20260929000080_shortcut_match_ack'));
  await db.exec(migration('20260929000110_shortcut_create_transaction'));
  await db.exec(migration('20260929000120_shortcut_match_reversal'));
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

const match = (item: string, transaction: string): string =>
  `SELECT public.acknowledge_shortcut_match('${item}','${transaction}') AS id`;
const reverse = (item: string, decision: string): string =>
  `SELECT public.reverse_shortcut_match('${item}','${decision}') AS id`;

describe('Shortcut match reversal', () => {
  it('records a single owner-scoped reversal, returns the inbox to review, and leaves finances untouched', async () => {
    const db = await database();
    try {
      const decision = (
        (await asUser(db, owner, match(inbox, transactionA))) as Array<{ id: string }>
      )[0].id;
      const first = await asUser(db, owner, reverse(inbox, decision));
      expect(await asUser(db, owner, reverse(inbox, decision))).toEqual(first);
      expect(
        (
          await db.query(
            `SELECT status,raw_text FROM public.shortcut_inbox_items WHERE id='${inbox}'`
          )
        ).rows
      ).toEqual([{ status: 'pending', raw_text: 'Synthetic receipt' }]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.shortcut_inbox_match_decisions'))
          .rows
      ).toEqual([{ count: 1 }]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.shortcut_inbox_match_reversals'))
          .rows
      ).toEqual([{ count: 1 }]);
      expect(
        (await db.query(`SELECT balance FROM public.accounts WHERE id='${account}'`)).rows
      ).toEqual([{ balance: '10000.00' }]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.transactions')).rows
      ).toEqual([{ count: 2 }]);
    } finally {
      await db.close();
    }
  });

  it('rejects cross-owner, stale and created decisions, while permitting a new reviewed match', async () => {
    const db = await database();
    try {
      const first = (
        (await asUser(db, owner, match(inbox, transactionA))) as Array<{ id: string }>
      )[0].id;
      await expect(asUser(db, other, reverse(inbox, first))).rejects.toThrow();
      await expect(asUser(db, owner, reverse(otherInbox, first))).rejects.toThrow();
      const firstReversal = await asUser(db, owner, reverse(inbox, first));
      await expect(asUser(db, owner, match(inbox, transactionA))).rejects.toThrow();
      const second = (
        (await asUser(db, owner, match(inbox, transactionB))) as Array<{ id: string }>
      )[0].id;
      expect(second).not.toBe(first);
      expect(await asUser(db, owner, reverse(inbox, first))).toEqual(firstReversal);
      await expect(asUser(db, owner, match(inbox, transactionA))).rejects.toThrow();
      expect(
        (await db.query(`SELECT status FROM public.shortcut_inbox_items WHERE id='${inbox}'`)).rows
      ).toEqual([{ status: 'matched' }]);
      await db.exec(`DELETE FROM public.transactions WHERE id='${transactionA}'`);
      expect(
        (await db.query(`SELECT status FROM public.shortcut_inbox_items WHERE id='${inbox}'`)).rows
      ).toEqual([{ status: 'matched' }]);
      const row = await db.query(
        `SELECT count(*)::int AS count FROM public.shortcut_inbox_match_decisions WHERE id='${second}'`
      );
      expect(row.rows).toEqual([{ count: 1 }]);
      await asUser(db, owner, reverse(inbox, second));
      expect(
        (await db.query(`SELECT status FROM public.shortcut_inbox_items WHERE id='${inbox}'`)).rows
      ).toEqual([{ status: 'pending' }]);
    } finally {
      await db.close();
    }
  });

  it('allows reviewed creation after reversal but never reverses a created transaction', async () => {
    const db = await database();
    try {
      const decision = (
        (await asUser(db, owner, match(inbox, transactionA))) as Array<{ id: string }>
      )[0].id;
      await asUser(db, owner, reverse(inbox, decision));
      const payload = JSON.stringify({
        account_id: account,
        category_id: category,
        type: 'expense',
        amount: '1500.00',
        date: '2026-09-28',
        description: 'Separate reviewed expense'
      });
      const result = await asUser(
        db,
        owner,
        `SELECT public.confirm_shortcut_transaction('${inbox}','${payload}'::jsonb,'',false) AS result`
      );
      expect(result).toMatchObject([{ result: { status: 'created', replayed: false } }]);
      const createdDecision = (result[0] as { result: { decision_id: string } }).result.decision_id;
      const createdTransaction = (result[0] as { result: { transaction_id: string } }).result
        .transaction_id;
      await expect(asUser(db, owner, match(inbox, createdTransaction))).rejects.toThrow();
      await expect(asUser(db, owner, reverse(inbox, createdDecision))).rejects.toThrow();
      expect(
        (await db.query(`SELECT status FROM public.shortcut_inbox_items WHERE id='${inbox}'`)).rows
      ).toEqual([{ status: 'created' }]);
      expect(
        (await db.query(`SELECT balance FROM public.accounts WHERE id='${account}'`)).rows
      ).toEqual([{ balance: '8500.00' }]);
    } finally {
      await db.close();
    }
  });

  it('does not allow direct status or audit mutation', async () => {
    const db = await database();
    try {
      const decision = (
        (await asUser(db, owner, match(inbox, transactionA))) as Array<{ id: string }>
      )[0].id;
      await expect(
        asUser(
          db,
          owner,
          `UPDATE public.shortcut_inbox_items SET status='pending' WHERE id='${inbox}'`
        )
      ).rejects.toThrow();
      await asUser(db, owner, reverse(inbox, decision));
      await expect(
        asUser(
          db,
          owner,
          `UPDATE public.shortcut_inbox_items SET status='matched' WHERE id='${inbox}'`
        )
      ).rejects.toThrow();
      await expect(
        asUser(db, owner, 'DELETE FROM public.shortcut_inbox_match_reversals')
      ).rejects.toThrow();
      expect(
        await asUser(
          db,
          other,
          'SELECT count(*)::int AS count FROM public.shortcut_inbox_match_reversals'
        )
      ).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });

  it('erases historical decisions and reversals when the inbox item is hard deleted', async () => {
    const db = await database();
    try {
      const decision = (
        (await asUser(db, owner, match(inbox, transactionA))) as Array<{ id: string }>
      )[0].id;
      await asUser(db, owner, reverse(inbox, decision));
      await db.exec(`DELETE FROM public.shortcut_inbox_items WHERE id='${inbox}'`);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.shortcut_inbox_match_decisions'))
          .rows
      ).toEqual([{ count: 0 }]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.shortcut_inbox_match_reversals'))
          .rows
      ).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });
});
