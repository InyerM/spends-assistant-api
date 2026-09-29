import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const migration = (name: string): string =>
  readFileSync(join(process.cwd(), `supabase/migrations/${name}.sql`), 'utf8');
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const inboxA = '10000000-0000-4000-8000-000000000001';
const inboxB = '10000000-0000-4000-8000-000000000002';
const inboxOther = '10000000-0000-4000-8000-000000000003';
const accountA = '20000000-0000-4000-8000-000000000001';
const accountOther = '20000000-0000-4000-8000-000000000002';
const categoryA = '30000000-0000-4000-8000-000000000001';
const categoryOther = '30000000-0000-4000-8000-000000000002';

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
    INSERT INTO public.accounts VALUES ('${accountA}','${owner}',10000,true,NULL),
      ('${accountOther}','${other}',5000,true,NULL);
    INSERT INTO public.categories VALUES ('${categoryA}','${owner}','expense',true,NULL),
      ('${categoryOther}','${other}','expense',true,NULL);
    INSERT INTO public.subscriptions VALUES ('${owner}','free'), ('${other}','free');
    INSERT INTO public.app_settings VALUES ('free_transactions_limit','50');
  `);
  await db.exec(migration('20260929000030_shortcut_inbox'));
  await db.exec(`
    INSERT INTO public.shortcut_inbox_items
      (id,user_id,source,external_id,received_at,raw_text,idempotency_key) VALUES
      ('${inboxA}','${owner}','sms-shortcut','receipt-1','2026-09-28T10:00:00Z',
        'Synthetic receipt 1',repeat('a',64)),
      ('${inboxB}','${owner}','sms-shortcut','receipt-2','2026-09-28T11:00:00Z',
        'Synthetic receipt 2',repeat('b',64)),
      ('${inboxOther}','${other}','sms-shortcut','receipt-3','2026-09-28T12:00:00Z',
        'Synthetic receipt 3',repeat('c',64));
  `);
  await db.exec(migration('20260929000080_shortcut_match_ack'));
  await db.exec(migration('20260929000110_shortcut_create_transaction'));
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

const payload = (overrides = ''): string =>
  `'{"account_id":"${accountA}","category_id":"${categoryA}","type":"expense","amount":"1200.50","date":"2026-09-28","description":"Reviewed market expense"${overrides}}'::jsonb`;
const create = (
  item = inboxA,
  reviewHash = '',
  confirmDistinct = false,
  reviewedPayload = payload()
): string =>
  `SELECT public.confirm_shortcut_transaction('${item}',${reviewedPayload},'${reviewHash}',${confirmDistinct}) AS result`;

describe('reviewed Shortcut transaction creation', () => {
  it('creates one owned transaction, balance change, quota count and immutable decision; retry replays', async () => {
    const db = await database();
    try {
      const first = await asUser(db, owner, create());
      expect(first).toMatchObject([{ result: { status: 'created', replayed: false } }]);
      const retry = await asUser(db, owner, create());
      expect(retry).toMatchObject([{ result: { status: 'created', replayed: true } }]);
      expect((retry[0] as { result: { transaction_id: string } }).result.transaction_id).toBe(
        (first[0] as { result: { transaction_id: string } }).result.transaction_id
      );
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.transactions')).rows
      ).toEqual([{ count: 1 }]);
      expect(
        (await db.query(`SELECT balance FROM public.accounts WHERE id='${accountA}'`)).rows
      ).toEqual([{ balance: '8799.50' }]);
      expect((await db.query('SELECT transactions_count FROM public.usage_tracking')).rows).toEqual(
        [{ transactions_count: 1 }]
      );
      expect(
        (await db.query(`SELECT status FROM public.shortcut_inbox_items WHERE id='${inboxA}'`)).rows
      ).toEqual([{ status: 'created' }]);
      expect(
        (
          await db.query(
            "SELECT decision_type,transaction_snapshot->>'amount' AS amount FROM public.shortcut_inbox_match_decisions"
          )
        ).rows
      ).toEqual([{ decision_type: 'created', amount: '1200.50' }]);
    } finally {
      await db.close();
    }
  });

  it('requires renewed explicit review of existing same-value candidates but permits distinct payments', async () => {
    const db = await database();
    try {
      await asUser(db, owner, create());
      const preview = await asUser(db, owner, create(inboxB));
      const result = (
        preview[0] as { result: { status: string; candidate_hash: string; candidates: unknown[] } }
      ).result;
      expect(result.status).toBe('review_required');
      expect(result.candidates).toHaveLength(1);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.transactions')).rows
      ).toEqual([{ count: 1 }]);
      expect(await asUser(db, owner, create(inboxB, result.candidate_hash, true))).toMatchObject([
        { result: { status: 'created', replayed: false } }
      ]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.transactions')).rows
      ).toEqual([{ count: 2 }]);
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM public.transactions WHERE duplicate_status IS NOT NULL'
          )
        ).rows
      ).toEqual([{ count: 0 }]);
      expect(
        (await db.query(`SELECT balance FROM public.accounts WHERE id='${accountA}'`)).rows
      ).toEqual([{ balance: '7599.00' }]);
    } finally {
      await db.close();
    }
  });

  it('rejects cross-owner resources and invalid category/type without financial writes', async () => {
    const db = await database();
    try {
      await expect(asUser(db, owner, create(inboxOther))).rejects.toThrow();
      await expect(
        asUser(db, owner, create(inboxA, '', false, payload(`,"account_id":"${accountOther}"`)))
      ).rejects.toThrow();
      await expect(
        asUser(db, owner, create(inboxA, '', false, payload(`,"category_id":"${categoryOther}"`)))
      ).rejects.toThrow();
      await expect(
        asUser(db, owner, create(inboxA, '', false, payload(',"type":"income"')))
      ).rejects.toThrow();
      await expect(
        asUser(db, owner, create(inboxA, '', false, payload(',"amount":"0"')))
      ).rejects.toThrow();
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.transactions')).rows
      ).toEqual([{ count: 0 }]);
      expect(
        (await db.query(`SELECT balance FROM public.accounts WHERE id='${accountA}'`)).rows
      ).toEqual([{ balance: '10000.00' }]);
    } finally {
      await db.close();
    }
  });

  it('keeps immutable source identity, replays after soft delete, and resets review on hard erasure', async () => {
    const db = await database();
    try {
      const first = (await asUser(db, owner, create()))[0] as {
        result: { transaction_id: string };
      };
      const tx = first.result.transaction_id;
      expect(
        (
          await db.query(`SELECT source, raw_text,
        parsed_data->>'shortcut_source' AS shortcut_source,
        parsed_data->>'shortcut_external_id' AS external_id,
        parsed_data->>'shortcut_idempotency_key' AS idempotency_key,
        parsed_data->>'shortcut_received_at' AS received_at FROM public.transactions WHERE id='${tx}'`)
        ).rows
      ).toMatchObject([
        {
          source: 'shortcut_inbox',
          raw_text: 'Synthetic receipt 1',
          shortcut_source: 'sms-shortcut',
          external_id: 'receipt-1',
          idempotency_key: 'a'.repeat(64)
        }
      ]);
      await db.exec(`UPDATE public.transactions SET deleted_at=now() WHERE id='${tx}'`);
      expect(await asUser(db, owner, create())).toMatchObject([
        { result: { status: 'created', replayed: true } }
      ]);
      await db.exec(`DELETE FROM public.transactions WHERE id='${tx}'`);
      expect(
        (await db.query(`SELECT status FROM public.shortcut_inbox_items WHERE id='${inboxA}'`)).rows
      ).toEqual([{ status: 'pending' }]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.shortcut_inbox_match_decisions'))
          .rows
      ).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });

  it('does not let a canceled pro subscription bypass the free transaction quota', async () => {
    const db = await database();
    try {
      await db.exec(`UPDATE public.subscriptions SET plan='pro', status='canceled' WHERE user_id='${owner}';
        INSERT INTO public.usage_tracking(user_id,month,transactions_count)
        VALUES('${owner}',to_char(now() AT TIME ZONE 'UTC','YYYY-MM'),50);`);
      await expect(asUser(db, owner, create())).rejects.toThrow('Transaction limit exceeded');
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.transactions')).rows
      ).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });

  it('requires a fresh review if candidate details change after preview', async () => {
    const db = await database();
    try {
      await asUser(db, owner, create());
      const initial = (await asUser(db, owner, create(inboxB)))[0] as {
        result: { candidate_hash: string };
      };
      await db.exec("UPDATE public.transactions SET description='Updated existing payment'");
      const stale = (
        await asUser(db, owner, create(inboxB, initial.result.candidate_hash, true))
      )[0] as {
        result: { status: string; candidate_hash: string };
      };
      expect(stale.result.status).toBe('review_required');
      expect(stale.result.candidate_hash).not.toBe(initial.result.candidate_hash);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.transactions')).rows
      ).toEqual([{ count: 1 }]);
    } finally {
      await db.close();
    }
  });

  it('blocks creation and bounds details when more than 20 candidates exist', async () => {
    const db = await database();
    try {
      await db.exec(`INSERT INTO public.transactions
        (user_id,amount,date,time,description,account_id,category_id,type,source)
        SELECT '${owner}',1200.50,'2026-09-28','12:00','Synthetic existing payment',
          '${accountA}','${categoryA}','expense','web' FROM generate_series(1,21);`);
      const result = (await asUser(db, owner, create()))[0] as {
        result: { status: string; candidate_count: number; candidates: unknown[] };
      };
      expect(result.result.status).toBe('review_overflow');
      expect(result.result.candidate_count).toBe(21);
      expect(result.result.candidates).toHaveLength(20);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.transactions')).rows
      ).toEqual([{ count: 21 }]);
    } finally {
      await db.close();
    }
  });

  it('rejects a changed replay and direct edits to created status or audit', async () => {
    const db = await database();
    try {
      await asUser(db, owner, create());
      await expect(
        asUser(db, owner, create(inboxA, '', false, payload(',"amount":"1500"')))
      ).rejects.toThrow();
      await expect(
        asUser(
          db,
          owner,
          `UPDATE public.shortcut_inbox_items SET status='pending' WHERE id='${inboxA}'`
        )
      ).rejects.toThrow();
      await expect(
        asUser(
          db,
          owner,
          `DELETE FROM public.shortcut_inbox_match_decisions WHERE inbox_item_id='${inboxA}'`
        )
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});
