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
      deleted_at timestamptz, updated_at timestamptz DEFAULT now()
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
  await db.exec(
    `CREATE FUNCTION public.has_accepted_required_terms() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('test.terms', true), 'true') = 'true' $$;`
  );
  await db.exec(
    readFileSync(
      new URL('../supabase/migrations/20261008000031_account_balance_target.sql', import.meta.url),
      'utf8'
    )
  );
  await db.exec(
    `UPDATE public.accounts SET balance = 100 WHERE id = '${account}'; UPDATE public.app_settings SET value = '50' WHERE key = 'free_transactions_limit';`
  );
  return db;
}

async function call(
  db: PGlite,
  target: number,
  mode = 'transaction',
  request = 1,
  user = owner
): Promise<Record<string, unknown>> {
  await db.exec(`SET request.jwt.claim.sub = '${user}'; SET ROLE authenticated;`);
  try {
    const response = await db.query<{ result: Record<string, unknown> }>(
      'SELECT public.adjust_account_balance($1::uuid,$2::uuid,$3::numeric,$4::text,$5::text) AS result',
      [`77777777-7777-4777-8777-${String(request).padStart(12, '0')}`, account, target, mode, 'web']
    );
    return response.rows[0].result;
  } finally {
    await db.exec('RESET ROLE');
  }
}

describe('live account balance targets', () => {
  it('posts only the authoritative difference, replays once, and rejects altered retries', async () => {
    const db = await database();
    try {
      expect(await call(db, 80)).toMatchObject({ balance: 80, difference: -20, replayed: false });
      expect(await call(db, 80)).toMatchObject({ replayed: true });
      await expect(call(db, 150)).rejects.toThrow('different payload');
      expect((await db.query('SELECT amount, type FROM public.transactions')).rows).toEqual([
        { amount: '20.00', type: 'expense' }
      ]);
      expect(
        (await db.query(`SELECT balance FROM public.accounts WHERE id = '${account}'`)).rows
      ).toEqual([{ balance: '80.00' }]);
      expect((await db.query('SELECT transactions_count FROM public.usage_tracking')).rows).toEqual(
        [{ transactions_count: 1 }]
      );
      expect(await call(db, 150, 'transaction', 2)).toMatchObject({ difference: 70 });
    } finally {
      await db.close();
    }
  });
  it('sets the manual target exactly and audits unchanged balances without financial rows', async () => {
    const db = await database();
    try {
      expect(await call(db, -150.25, 'manual')).toMatchObject({
        balance: -150.25,
        transaction_id: null
      });
      expect(await call(db, -150.25, 'transaction', 2)).toMatchObject({
        difference: 0,
        transaction_id: null
      });
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.transactions')).rows
      ).toEqual([{ count: 0 }]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.usage_tracking')).rows
      ).toEqual([{ count: 0 }]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.account_balance_adjustments'))
          .rows
      ).toEqual([{ count: 2 }]);
    } finally {
      await db.close();
    }
  });
  it('uses a changed server balance and preserves exact cents for income and debt', async () => {
    const db = await database();
    try {
      await db.exec(`UPDATE public.accounts SET balance = 120.10 WHERE id = '${account}'`);
      expect(await call(db, 150.3)).toMatchObject({ previous_balance: 120.1, difference: 30.2 });
      expect((await db.query('SELECT amount, type FROM public.transactions')).rows).toEqual([
        { amount: '30.20', type: 'income' }
      ]);
      await call(db, -100, 'manual', 2);
      expect(await call(db, -150, 'transaction', 3)).toMatchObject({ difference: -50 });
    } finally {
      await db.close();
    }
  });
  it('rejects foreign ownership, missing auth, terms and imprecise targets without writes', async () => {
    const db = await database();
    try {
      await expect(call(db, 80, 'manual', 1, other)).rejects.toThrow('Owned active account');
      await expect(call(db, 80, 'manual', 1, '')).rejects.toThrow('Authentication required');
      await expect(call(db, 0.001, 'manual')).rejects.toThrow('Invalid balance');
      await db.exec(`SET test.terms = 'false'`);
      await expect(call(db, 80, 'manual')).rejects.toThrow('Required terms');
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.account_balance_adjustments'))
          .rows
      ).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });
  it('rolls back the adjustment if quota blocks financial posting', async () => {
    const db = await database();
    try {
      await db.exec(
        `UPDATE public.app_settings SET value = '0' WHERE key = 'free_transactions_limit'`
      );
      await expect(call(db, 80)).rejects.toThrow('Transaction limit exceeded');
      expect(
        (await db.query(`SELECT balance FROM public.accounts WHERE id = '${account}'`)).rows
      ).toEqual([{ balance: '100.00' }]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.account_balance_adjustments'))
          .rows
      ).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });
});
