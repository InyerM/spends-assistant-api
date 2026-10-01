import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const migrationPath = (name: string): string =>
  join(process.cwd(), `supabase/migrations/${name}.sql`);
const migration = (name: string): string => readFileSync(migrationPath(name), 'utf8');
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const lulo = '10000000-0000-4000-8000-000000000001';
const sms = '10000000-0000-4000-8000-000000000002';
const luloOther = '10000000-0000-4000-8000-000000000003';
const luloReview = '10000000-0000-4000-8000-000000000004';
const account = '20000000-0000-4000-8000-000000000001';
const category = '30000000-0000-4000-8000-000000000001';
const existingTransaction = '40000000-0000-4000-8000-000000000001';

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
    CREATE TABLE public.accounts (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id), balance numeric(15,2),
      is_active boolean DEFAULT true, deleted_at timestamptz
    );
    CREATE TABLE public.categories (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id),
      type text NOT NULL CHECK (type IN ('expense','income','transfer')),
      is_active boolean DEFAULT true, deleted_at timestamptz
    );
    CREATE TABLE public.transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id),
      amount numeric(15,2) NOT NULL CHECK (amount > 0), date date NOT NULL,
      time time NOT NULL, description text NOT NULL, account_id uuid NOT NULL
        REFERENCES public.accounts(id), category_id uuid REFERENCES public.categories(id),
      type text NOT NULL CHECK (type IN ('expense','income','transfer')),
      source varchar(50) NOT NULL, raw_text text, parsed_data jsonb, duplicate_status text,
      deleted_at timestamptz, CONSTRAINT transactions_id_user_unique UNIQUE (id, user_id)
    );
    CREATE TABLE public.usage_tracking (
      user_id uuid NOT NULL, month text NOT NULL, transactions_count integer NOT NULL DEFAULT 0,
      updated_at timestamptz DEFAULT now(), PRIMARY KEY(user_id, month)
    );
    CREATE TABLE public.subscriptions (user_id uuid PRIMARY KEY, plan text NOT NULL,
      status text NOT NULL DEFAULT 'active');
    CREATE TABLE public.app_settings (key text PRIMARY KEY, value jsonb NOT NULL);
    INSERT INTO auth.users VALUES ('${owner}'), ('${other}');
    INSERT INTO public.accounts VALUES ('${account}','${owner}',10000,true,NULL);
    INSERT INTO public.categories VALUES ('${category}','${owner}','expense',true,NULL);
    INSERT INTO public.subscriptions VALUES ('${owner}','free'), ('${other}','free');
    INSERT INTO public.app_settings VALUES ('free_transactions_limit','50');
  `);
  await db.exec(migration('20260929000030_shortcut_inbox'));
  await db.exec(`
    INSERT INTO public.shortcut_inbox_items
      (id,user_id,source,external_id,received_at,raw_text,idempotency_key) VALUES
      ('${lulo}','${owner}','lulo-email-backfill','mail-1','2026-09-28T10:00:00Z',
        'Synthetic Lulo notice 1',repeat('a',64)),
      ('${sms}','${owner}','sms-manual-backfill','sms-1','2026-09-28T11:00:00Z',
        'Synthetic SMS notice',repeat('b',64)),
      ('${luloOther}','${other}','lulo-email-backfill','mail-2','2026-09-28T12:00:00Z',
        'Synthetic Lulo notice other',repeat('c',64)),
      ('${luloReview}','${owner}','lulo-email-backfill','mail-3','2026-09-28T13:00:00Z',
        'Synthetic Lulo notice 3',repeat('d',64));
  `);
  await db.exec(migration('20260929000080_shortcut_match_ack'));
  await db.exec(migration('20260929000110_shortcut_create_transaction'));
  await db.exec(migration('20260929000120_shortcut_match_reversal'));
  await db.exec(migration('20260929000180_shortcut_reviewed_event_time'));
  await db.exec(migration('20260929000250_lulo_shortcut_create_guard'));
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

const payload = `'{"account_id":"${account}","category_id":"${category}","type":"expense","amount":"1200.50","date":"2026-09-28","description":"Reviewed synthetic purchase"}'::jsonb`;
const create = (inboxId: string): string =>
  `SELECT public.confirm_shortcut_transaction('${inboxId}',${payload},'',false) AS result`;

describe('Lulo email Shortcut create guard', () => {
  it('rolls back an authenticated direct RPC create with no transaction, balance, quota or decision change', async () => {
    const db = await database();
    try {
      await expect(asUser(db, owner, create(lulo))).rejects.toThrow('Lulo email');
      expect((await db.query('SELECT count(*)::int AS n FROM public.transactions')).rows).toEqual([
        { n: 0 }
      ]);
      expect(
        (await db.query(`SELECT balance FROM public.accounts WHERE id='${account}'`)).rows
      ).toEqual([{ balance: '10000.00' }]);
      expect((await db.query('SELECT count(*)::int AS n FROM public.usage_tracking')).rows).toEqual(
        [{ n: 0 }]
      );
      expect(
        (await db.query('SELECT count(*)::int AS n FROM public.shortcut_inbox_match_decisions'))
          .rows
      ).toEqual([{ n: 0 }]);
      expect(
        (await db.query(`SELECT status FROM public.shortcut_inbox_items WHERE id='${lulo}'`)).rows
      ).toEqual([{ status: 'pending' }]);
      await expect(asUser(db, owner, create(lulo))).rejects.toThrow('Lulo email');
    } finally {
      await db.close();
    }
  });

  it('keeps non-Lulo creation and idempotent replay unchanged', async () => {
    const db = await database();
    try {
      const first = await asUser(db, owner, create(sms));
      expect(first).toMatchObject([{ result: { status: 'created', replayed: false } }]);
      const second = await asUser(db, owner, create(sms));
      expect(second).toMatchObject([{ result: { status: 'created', replayed: true } }]);
      expect((await db.query('SELECT count(*)::int AS n FROM public.transactions')).rows).toEqual([
        { n: 1 }
      ]);
      expect(
        (await db.query(`SELECT balance FROM public.accounts WHERE id='${account}'`)).rows
      ).toEqual([{ balance: '8799.50' }]);
      expect((await db.query('SELECT transactions_count FROM public.usage_tracking')).rows).toEqual(
        [{ transactions_count: 1 }]
      );
    } finally {
      await db.close();
    }
  });

  it('allows an owner to match a Lulo notice to an existing transaction without changing balances', async () => {
    const db = await database();
    try {
      await db.exec(`INSERT INTO public.transactions
        (id,user_id,date,time,amount,description,type,source,account_id,category_id)
        VALUES ('${existingTransaction}','${owner}','2026-09-28','05:00',1200.50,
          'Existing purchase','expense','manual','${account}','${category}')`);
      const sql = `SELECT public.acknowledge_shortcut_match('${lulo}','${existingTransaction}') AS id`;
      const first = await asUser(db, owner, sql);
      expect(first).toMatchObject([{ id: expect.any(String) }]);
      expect(await asUser(db, owner, sql)).toEqual(first);
      expect(
        (await db.query(`SELECT status FROM public.shortcut_inbox_items WHERE id='${lulo}'`)).rows
      ).toEqual([{ status: 'matched' }]);
      expect(
        (await db.query('SELECT decision_type FROM public.shortcut_inbox_match_decisions')).rows
      ).toEqual([{ decision_type: 'matched' }]);
      expect(
        (await db.query(`SELECT balance FROM public.accounts WHERE id='${account}'`)).rows
      ).toEqual([{ balance: '10000.00' }]);
      expect((await db.query('SELECT count(*)::int AS n FROM public.usage_tracking')).rows).toEqual(
        [{ n: 0 }]
      );
      await asUser(
        db,
        owner,
        `UPDATE public.shortcut_inbox_items SET status='non_transaction'
        WHERE id='${luloReview}'`
      );
      expect(
        (await db.query(`SELECT status FROM public.shortcut_inbox_items WHERE id='${luloReview}'`))
          .rows
      ).toEqual([{ status: 'non_transaction' }]);
    } finally {
      await db.close();
    }
  });

  it('preserves owner isolation and rejects a direct created-decision insert', async () => {
    const db = await database();
    try {
      await expect(asUser(db, other, create(lulo))).rejects.toThrow('Inbox item not found');
      await expect(asUser(db, owner, create(luloOther))).rejects.toThrow('Inbox item not found');
      await db.exec(`INSERT INTO public.transactions
        (id,user_id,date,time,amount,description,type,source,account_id,category_id)
        VALUES ('${existingTransaction}','${owner}','2026-09-28','05:00',1200.50,
          'Existing purchase','expense','manual','${account}','${category}')`);
      const directDecision = `INSERT INTO public.shortcut_inbox_match_decisions
        (user_id,inbox_item_id,transaction_id,transaction_snapshot,decision_type,reviewed_payload)
        VALUES ('${owner}','${lulo}','${existingTransaction}','{}','created','{}')`;
      await expect(asUser(db, owner, directDecision)).rejects.toThrow('permission denied');
      await expect(
        db.exec(`INSERT INTO public.shortcut_inbox_match_decisions
        (user_id,inbox_item_id,transaction_id,transaction_snapshot,decision_type,reviewed_payload)
        VALUES ('${owner}','${lulo}','${existingTransaction}','{}','created','{}')`)
      ).rejects.toThrow('Lulo email');
      expect(
        (await db.query('SELECT count(*)::int AS n FROM public.shortcut_inbox_match_decisions'))
          .rows
      ).toEqual([{ n: 0 }]);
    } finally {
      await db.close();
    }
  });
});
