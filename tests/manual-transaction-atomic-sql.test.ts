import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../supabase/migrations/20260929000130_manual_transaction_atomic.sql', import.meta.url),
  'utf8'
);
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const account = '33333333-3333-4333-8333-333333333333';
const destination = '44444444-4444-4444-8444-444444444444';
const otherAccount = '55555555-5555-4555-8555-555555555555';
const category = '66666666-6666-4666-8666-666666666666';
const transferCategory = '66666666-6666-4666-8666-666666666667';

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE ROLE anon;
    CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE TABLE public.accounts (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id),
      balance numeric(15,2) DEFAULT 0, is_active boolean DEFAULT true,
      deleted_at timestamptz
    );
    CREATE TABLE public.categories (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id),
      type text NOT NULL, is_active boolean DEFAULT true, deleted_at timestamptz
    );
    CREATE TABLE public.transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id),
      date date NOT NULL, time time NOT NULL, amount numeric(15,2) NOT NULL CHECK (amount > 0),
      description text NOT NULL, notes text, category_id uuid REFERENCES public.categories(id),
      account_id uuid NOT NULL REFERENCES public.accounts(id), type text NOT NULL,
      payment_method text, source text NOT NULL, confidence integer,
      transfer_to_account_id uuid REFERENCES public.accounts(id), transfer_id uuid,
      is_reconciled boolean DEFAULT false, reconciled_at timestamptz,
      reconciliation_id uuid, raw_text text, parsed_data jsonb, applied_rules jsonb,
      duplicate_status text, duplicate_of uuid REFERENCES public.transactions(id),
      deleted_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE public.document_observations (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id),
      status text NOT NULL, match_transaction_id uuid REFERENCES public.transactions(id)
    );
    CREATE TABLE public.shortcut_inbox_match_decisions (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id),
      transaction_id uuid NOT NULL REFERENCES public.transactions(id)
    );
    CREATE TABLE public.shortcut_inbox_match_reversals (
      decision_id uuid PRIMARY KEY REFERENCES public.shortcut_inbox_match_decisions(id)
    );
    GRANT INSERT ON public.transactions TO authenticated;
    CREATE TABLE public.usage_tracking (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES auth.users(id), month text NOT NULL,
      ai_parses_used integer NOT NULL DEFAULT 0, ai_parses_limit integer NOT NULL DEFAULT 15,
      transactions_count integer NOT NULL DEFAULT 0, transactions_limit integer NOT NULL DEFAULT 50,
      updated_at timestamptz DEFAULT now(), UNIQUE(user_id, month)
    );
    GRANT SELECT, INSERT, UPDATE ON public.usage_tracking TO authenticated;
    GRANT UPDATE (transactions_count, updated_at) ON public.usage_tracking TO authenticated;
    CREATE TABLE public.subscriptions (
      user_id uuid PRIMARY KEY REFERENCES auth.users(id), plan text NOT NULL, status text NOT NULL
    );
    CREATE TABLE public.app_settings(key text PRIMARY KEY, value jsonb NOT NULL);
    INSERT INTO auth.users VALUES ('${owner}'), ('${other}');
    INSERT INTO public.accounts(id,user_id,balance) VALUES
      ('${account}','${owner}',10000), ('${destination}','${owner}',3000),
      ('${otherAccount}','${other}',5000);
    INSERT INTO public.categories(id,user_id,type) VALUES
      ('${category}','${owner}','expense'),
      ('${transferCategory}','${owner}','transfer');
    INSERT INTO public.subscriptions VALUES ('${owner}','free','active'), ('${other}','free','active');
    INSERT INTO public.app_settings VALUES ('free_transactions_limit','1');
  `);
  await db.exec(migration);
  return db;
}

async function call(
  db: PGlite,
  requestId: string,
  payload: Record<string, unknown>,
  options: { user?: string; force?: boolean; replaceId?: string } = {}
): Promise<Record<string, unknown>> {
  await db.exec(`SET request.jwt.claim.sub = '${options.user ?? owner}'; SET ROLE authenticated;`);
  try {
    const result = await db.query<{ confirm_manual_transaction: Record<string, unknown> }>(
      'SELECT public.confirm_manual_transaction($1::uuid,$2::jsonb,$3::boolean,$4::uuid)',
      [requestId, JSON.stringify(payload), options.force ?? false, options.replaceId ?? null]
    );
    return result.rows[0].confirm_manual_transaction;
  } finally {
    await db.exec('RESET ROLE;');
  }
}

const payload = (overrides: Record<string, unknown> = {}) => ({
  date: '2026-09-28', time: '12:00', amount: 1200, description: 'Synthetic expense',
  account_id: account, category_id: category, type: 'expense', source: 'web',
  ...overrides,
});
const id = (n: number) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;

describe('atomic manual transaction confirmation', () => {
  it('creates once, updates balance and UTC quota, and replays the same request', async () => {
    const db = await database();
    try {
      const first = await call(db, id(1), payload());
      const replay = await call(db, id(1), payload());
      expect(first.status).toBe('created');
      expect(replay).toMatchObject({ status: 'created', replayed: true });
      expect((replay.transaction as { id: string }).id).toBe((first.transaction as { id: string }).id);
      expect((await db.query(`SELECT balance FROM public.accounts WHERE id='${account}'`)).rows)
        .toEqual([{ balance: '8800.00' }]);
      expect((await db.query(`SELECT transactions_count FROM public.usage_tracking
        WHERE user_id='${owner}' AND month=to_char(now() AT TIME ZONE 'UTC','YYYY-MM')`)).rows)
        .toEqual([{ transactions_count: 1 }]);
      expect((await db.query('SELECT count(*)::integer AS count FROM public.transactions')).rows)
        .toEqual([{ count: 1 }]);
      await expect(call(db, id(1), payload({ amount: 2000 }))).rejects.toThrow(/different payload/);
    } finally { await db.close(); }
  });

  it('rechecks duplicates in the database and lets force preserve a distinct payment', async () => {
    const db = await database();
    try {
      await call(db, id(2), payload());
      const duplicate = await call(db, id(3), payload());
      expect(duplicate).toMatchObject({ status: 'duplicate' });
      await db.exec(`UPDATE public.subscriptions SET plan='pro',status='active' WHERE user_id='${owner}'`);
      const forced = await call(db, id(4), payload(), { force: true });
      expect(forced).toMatchObject({ status: 'created' });
      expect((forced.transaction as { duplicate_status: string }).duplicate_status).toBe('confirmed');
    } finally { await db.close(); }
  });

  it('applies transfer and replacement balance changes atomically without consuming another slot', async () => {
    const db = await database();
    try {
      const first = await call(db, id(5), payload({ type: 'transfer', category_id: transferCategory,
        transfer_to_account_id: destination }));
      const originalId = (first.transaction as { id: string }).id;
      const replacement = await call(db, id(6), payload({ amount: 500, description: 'Corrected transfer',
        type: 'transfer', category_id: transferCategory,
        transfer_to_account_id: destination }), { replaceId: originalId });
      expect(replacement.status).toBe('created');
      expect((await db.query(`SELECT id,balance FROM public.accounts WHERE id IN ('${account}','${destination}') ORDER BY id`)).rows)
        .toEqual([{ id: account, balance: '9500.00' }, { id: destination, balance: '3500.00' }]);
      expect((await db.query(`SELECT transactions_count FROM public.usage_tracking WHERE user_id='${owner}'`)).rows)
        .toEqual([{ transactions_count: 1 }]);
      expect((await db.query(`SELECT deleted_at IS NOT NULL AS deleted FROM public.transactions WHERE id='${originalId}'`)).rows)
        .toEqual([{ deleted: true }]);
    } finally { await db.close(); }
  });

  it('rejects replacing a document-confirmed transaction without changing its balance or link', async () => {
    const db = await database();
    try {
      const first = await call(db, id(22), payload());
      const originalId = (first.transaction as { id: string }).id;
      await db.query(`INSERT INTO public.document_observations(id,user_id,status,match_transaction_id)
        VALUES ($1,$2,'confirmed',$3)`, [id(23), owner, originalId]);

      await expect(call(db, id(24), payload({ amount: 500 }), { replaceId: originalId }))
        .rejects.toThrow(/reviewed document or Shortcut decision/);
      expect((await db.query(`SELECT deleted_at FROM public.transactions WHERE id=$1`, [originalId])).rows)
        .toEqual([{ deleted_at: null }]);
      expect((await db.query(`SELECT status,match_transaction_id FROM public.document_observations
        WHERE id=$1`, [id(23)])).rows)
        .toEqual([{ status: 'confirmed', match_transaction_id: originalId }]);
      expect((await db.query(`SELECT balance FROM public.accounts WHERE id=$1`, [account])).rows)
        .toEqual([{ balance: '8800.00' }]);
      expect((await db.query(`SELECT transactions_count FROM public.usage_tracking
        WHERE user_id=$1`, [owner])).rows).toEqual([{ transactions_count: 1 }]);
      expect((await db.query(`SELECT count(*)::integer AS count FROM public.transactions`)).rows)
        .toEqual([{ count: 1 }]);
    } finally { await db.close(); }
  });

  it('rejects replacing an active Shortcut match but permits an already reversed match', async () => {
    const db = await database();
    try {
      const first = await call(db, id(25), payload());
      const originalId = (first.transaction as { id: string }).id;
      await db.query(`INSERT INTO public.shortcut_inbox_match_decisions(id,user_id,transaction_id)
        VALUES ($1,$2,$3)`, [id(26), owner, originalId]);

      await expect(call(db, id(27), payload({ amount: 500 }), { replaceId: originalId }))
        .rejects.toThrow(/reviewed document or Shortcut decision/);
      expect((await db.query(`SELECT balance FROM public.accounts WHERE id=$1`, [account])).rows)
        .toEqual([{ balance: '8800.00' }]);
      expect((await db.query(`SELECT deleted_at FROM public.transactions WHERE id=$1`, [originalId])).rows)
        .toEqual([{ deleted_at: null }]);

      await db.query(`INSERT INTO public.shortcut_inbox_match_reversals(decision_id)
        VALUES ($1)`, [id(26)]);
      const replacement = await call(db, id(27), payload({ amount: 500 }),
        { replaceId: originalId });
      expect(replacement.status).toBe('created');
      expect((await db.query(`SELECT balance FROM public.accounts WHERE id=$1`, [account])).rows)
        .toEqual([{ balance: '9500.00' }]);
    } finally { await db.close(); }
  });

  it('blocks a canceled pro above the limit and allows active pro', async () => {
    const db = await database();
    try {
      await call(db, id(7), payload());
      await db.exec(`UPDATE public.subscriptions SET plan='pro',status='canceled' WHERE user_id='${owner}'`);
      await expect(call(db, id(8), payload({ amount: 1300 }))).rejects.toThrow(/Transaction limit exceeded/);
      await db.exec(`UPDATE public.subscriptions SET status='active' WHERE user_id='${owner}'`);
      expect((await call(db, id(8), payload({ amount: 1300 }))).status).toBe('created');
    } finally { await db.close(); }
  });

  it('rejects cross-owner accounts and replacements before financial writes', async () => {
    const db = await database();
    try {
      await expect(call(db, id(9), payload({ account_id: otherAccount }))).rejects.toThrow(/Account/);
      await expect(call(db, id(10), payload({ type: 'transfer', transfer_to_account_id: otherAccount })))
        .rejects.toThrow(/Account/);
      const otherTx = await call(db, id(11), payload({ account_id: otherAccount,
        category_id: null }), { user: other });
      await expect(call(db, id(12), payload(), { replaceId: (otherTx.transaction as { id: string }).id }))
        .rejects.toThrow(/Replacement/);
      expect((await db.query(`SELECT balance FROM public.accounts WHERE id='${account}'`)).rows)
        .toEqual([{ balance: '10000.00' }]);
    } finally { await db.close(); }
  });

  it('takes ownership from auth.uid rather than client-supplied transaction fields', async () => {
    const db = await database();
    try {
      const result = await call(db, id(16), payload({ user_id: other,
        deleted_at: '2026-09-28T00:00:00Z', id: id(17) }));
      const created = result.transaction as { id: string; user_id: string; deleted_at: string | null };
      expect(created.user_id).toBe(owner);
      expect(created.id).not.toBe(id(17));
      expect(created.deleted_at).toBeNull();
    } finally { await db.close(); }
  });

  it('rejects a category whose type differs from the transaction type', async () => {
    const db = await database();
    try {
      await expect(call(db, id(18), payload({ type: 'income' }))).rejects.toThrow(/Category.*type/);
      expect((await db.query('SELECT count(*)::integer AS count FROM public.transactions')).rows)
        .toEqual([{ count: 0 }]);
    } finally { await db.close(); }
  });

  it('requires a distinct destination for a transfer and forbids one on other types', async () => {
    const db = await database();
    try {
      await expect(call(db, id(19), payload({ type: 'transfer', category_id: null })))
        .rejects.toThrow(/Transfer destination/);
      await expect(call(db, id(20), payload({ type: 'transfer', category_id: null,
        transfer_to_account_id: account }))).rejects.toThrow(/Transfer destination/);
      await expect(call(db, id(21), payload({ transfer_to_account_id: destination })))
        .rejects.toThrow(/Transfer destination/);
      expect((await db.query('SELECT count(*)::integer AS count FROM public.transactions')).rows)
        .toEqual([{ count: 0 }]);
    } finally { await db.close(); }
  });

  it('rolls back transaction, balance and counter when an account update fails', async () => {
    const db = await database();
    try {
      await db.exec(`CREATE FUNCTION public.reject_balance() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Synthetic balance failure'; END $$;
        CREATE TRIGGER reject_balance BEFORE UPDATE ON public.accounts
          FOR EACH ROW EXECUTE FUNCTION public.reject_balance();`);
      await expect(call(db, id(13), payload())).rejects.toThrow(/Synthetic balance failure/);
      expect((await db.query('SELECT count(*)::integer AS count FROM public.transactions')).rows)
        .toEqual([{ count: 0 }]);
      expect((await db.query('SELECT count(*)::integer AS count FROM public.usage_tracking')).rows)
        .toEqual([{ count: 0 }]);
    } finally { await db.close(); }
  });

  it('limits execution to authenticated callers', async () => {
    const db = await database();
    try {
      await db.exec(`SET ROLE anon`);
      await expect(db.query(`SELECT public.confirm_manual_transaction('${id(14)}','{}',false,null)`))
        .rejects.toThrow(/permission denied/);
      await db.exec('RESET ROLE');
    } finally { await db.close(); }
  });

  it('keeps authenticated direct inserts available for existing mobile offline sync', async () => {
    const db = await database();
    try {
      await db.exec(`SET request.jwt.claim.sub = '${owner}'; SET ROLE authenticated;`);
      await db.query(`INSERT INTO public.transactions(user_id,date,time,amount,description,
        account_id,type,source) VALUES ('${owner}','2026-09-28','12:00',100,
        'Mobile offline sync','${account}','expense','mobile')`);
      await db.exec('RESET ROLE');
      expect((await db.query('SELECT count(*)::integer AS count FROM public.transactions')).rows)
        .toEqual([{ count: 1 }]);
    } finally { await db.close(); }
  });

  it('prevents authenticated clients from resetting or preloading monthly transaction counts', async () => {
    const db = await database();
    try {
      await call(db, id(15), payload());
      await db.exec(`SET request.jwt.claim.sub = '${owner}'; SET ROLE authenticated;`);
      await expect(db.query(`UPDATE public.usage_tracking SET transactions_count=0
        WHERE user_id='${owner}'`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`INSERT INTO public.usage_tracking(user_id,month,transactions_count)
        VALUES ('${owner}','2099-01',-100)`)).rejects.toThrow(/permission denied/);
      await db.exec('RESET ROLE');
    } finally { await db.close(); }
  });
});
