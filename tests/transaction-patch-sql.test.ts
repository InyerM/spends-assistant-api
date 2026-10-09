import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../supabase/migrations/20260929000150_atomic_transaction_patch.sql', import.meta.url),
  'utf8'
);
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const source = '33333333-3333-4333-8333-333333333333';
const destination = '44444444-4444-4444-8444-444444444444';
const foreignAccount = '55555555-5555-4555-8555-555555555555';
const transaction = '66666666-6666-4666-8666-666666666666';
const foreignTransaction = '77777777-7777-4777-8777-777777777777';
const expenseCategory = '88888888-8888-4888-8888-888888888888';
const incomeCategory = '99999999-9999-4999-8999-999999999999';

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE ROLE anon;
    CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY, raw_app_meta_data jsonb DEFAULT '{}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE TABLE public.accounts (
      id uuid PRIMARY KEY, user_id uuid REFERENCES auth.users(id), balance numeric(15,2),
      is_active boolean DEFAULT true, deleted_at timestamptz
    );
    CREATE TABLE public.categories (
      id uuid PRIMARY KEY, user_id uuid REFERENCES auth.users(id), type text,
      is_active boolean DEFAULT true, deleted_at timestamptz
    );
    CREATE TABLE public.transactions (
      id uuid PRIMARY KEY, user_id uuid REFERENCES auth.users(id), date date NOT NULL,
      time time NOT NULL, amount numeric(15,2) NOT NULL CHECK(amount > 0),
      description text NOT NULL, notes text, category_id uuid, account_id uuid NOT NULL,
      type text NOT NULL CHECK(type IN ('expense','income','transfer')),
      payment_method text, source text NOT NULL, transfer_to_account_id uuid,
      deleted_at timestamptz, updated_at timestamptz DEFAULT now(), UNIQUE(id,user_id)
    );
    CREATE TABLE public.document_observation_decisions (
      user_id uuid NOT NULL, transaction_id uuid
    );
    CREATE TABLE public.shortcut_inbox_match_decisions (
      id uuid PRIMARY KEY, user_id uuid NOT NULL, transaction_id uuid NOT NULL
    );
    CREATE TABLE public.shortcut_inbox_match_reversals (decision_id uuid UNIQUE);
    INSERT INTO auth.users(id) VALUES ('${owner}'), ('${other}');
    INSERT INTO public.accounts(id,user_id,balance) VALUES
      ('${source}','${owner}',900), ('${destination}','${owner}',1000),
      ('${foreignAccount}','${other}',500);
    INSERT INTO public.categories(id,user_id,type) VALUES
      ('${expenseCategory}','${owner}','expense'),
      ('${incomeCategory}','${owner}','income');
    INSERT INTO public.transactions(id,user_id,date,time,amount,description,category_id,
      account_id,type,source) VALUES
      ('${transaction}','${owner}','2026-09-29','12:00',100,'Synthetic expense',
        '${expenseCategory}','${source}','expense','web'),
      ('${foreignTransaction}','${other}','2026-09-29','12:00',100,'Other expense',
        NULL,'${foreignAccount}','expense','web');
  `);
  await db.exec(migration);
  await db.exec(
    readFileSync(
      new URL('../supabase/migrations/20261008000022_legal_acceptance.sql', import.meta.url),
      'utf8'
    )
  );
  const correction = new URL(
    '../supabase/migrations/20261008000033_document_transaction_metadata.sql',
    import.meta.url
  );
  await db.exec(readFileSync(correction, 'utf8'));
  return db;
}

async function patch(
  db: PGlite,
  body: Record<string, unknown>,
  options: {
    user?: string;
    id?: string;
  } = {}
): Promise<Record<string, unknown>> {
  await db.exec(`SET request.jwt.claim.sub = '${options.user ?? owner}'; SET ROLE authenticated;`);
  try {
    const result = await db.query<{ patch_reviewed_transaction: Record<string, unknown> }>(
      'SELECT public.patch_reviewed_transaction($1::uuid,$2::jsonb)',
      [options.id ?? transaction, JSON.stringify(body)]
    );
    return result.rows[0].patch_reviewed_transaction;
  } finally {
    await db.exec('RESET ROLE;');
  }
}

async function balances(db: PGlite): Promise<unknown[]> {
  return (
    await db.query(`SELECT id,balance FROM public.accounts
    WHERE id IN ('${source}','${destination}') ORDER BY id`)
  ).rows;
}

describe('atomic reviewed transaction patch', () => {
  it('moves an edited expense between accounts once, including an identical retry', async () => {
    const db = await database();
    try {
      const first = await patch(db, { amount: 150, account_id: destination });
      const retry = await patch(db, { amount: 150, account_id: destination });
      expect(first.id).toBe(transaction);
      expect(retry.id).toBe(transaction);
      expect(retry.amount).toBe(150);
      expect(await balances(db)).toEqual([
        { id: source, balance: '1000.00' },
        { id: destination, balance: '850.00' }
      ]);
    } finally {
      await db.close();
    }
  });

  it('rebalances both legs when an expense becomes a transfer', async () => {
    const db = await database();
    try {
      await patch(db, { type: 'transfer', category_id: null, transfer_to_account_id: destination });
      expect(await balances(db)).toEqual([
        { id: source, balance: '900.00' },
        { id: destination, balance: '1100.00' }
      ]);
    } finally {
      await db.close();
    }
  });

  it('rejects arbitrary provenance and ownership fields without changing the row', async () => {
    const db = await database();
    try {
      for (const body of [{ source: 'manual' }, { user_id: other }, { deleted_at: '2026-09-29' }]) {
        await expect(patch(db, body)).rejects.toThrow(/unsupported/i);
      }
      expect(
        (
          await db.query(`SELECT source,deleted_at,user_id FROM public.transactions
        WHERE id='${transaction}'`)
        ).rows
      ).toEqual([{ source: 'web', deleted_at: null, user_id: owner }]);
    } finally {
      await db.close();
    }
  });

  it('rejects another owner, foreign accounts and mismatched categories', async () => {
    const db = await database();
    try {
      await expect(patch(db, { amount: 200 }, { user: other })).rejects.toThrow(/not found/i);
      await expect(patch(db, { account_id: foreignAccount })).rejects.toThrow(/account/i);
      await expect(patch(db, { category_id: incomeCategory })).rejects.toThrow(/category/i);
      await expect(patch(db, { amount: 200 }, { id: foreignTransaction })).rejects.toThrow(
        /not found/i
      );
      expect(await balances(db)).toEqual([
        { id: source, balance: '900.00' },
        { id: destination, balance: '1000.00' }
      ]);
    } finally {
      await db.close();
    }
  });

  it('rolls back the transaction edit if a balance update fails', async () => {
    const db = await database();
    try {
      await db.exec(`CREATE FUNCTION reject_balance() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic account failure'; END $$;
        CREATE TRIGGER reject_balance BEFORE UPDATE ON public.accounts
        FOR EACH ROW EXECUTE FUNCTION reject_balance();`);
      await expect(patch(db, { amount: 200 })).rejects.toThrow(/synthetic account failure/);
      expect(
        (await db.query(`SELECT amount FROM public.transactions WHERE id='${transaction}'`)).rows
      ).toEqual([{ amount: '100.00' }]);
      expect(await balances(db)).toEqual([
        { id: source, balance: '900.00' },
        { id: destination, balance: '1000.00' }
      ]);
    } finally {
      await db.close();
    }
  });

  it('allows metadata edits for reviewed document and Shortcut matches', async () => {
    const db = await database();
    try {
      await db.exec(`INSERT INTO public.document_observation_decisions
        VALUES ('${owner}','${transaction}');`);
      expect((await patch(db, { description: 'Changed' })).description).toBe('Changed');
      await db.exec('DELETE FROM public.document_observation_decisions;');
      const decision = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      await db.exec(`INSERT INTO public.shortcut_inbox_match_decisions VALUES
        ('${decision}','${owner}','${transaction}');`);
      expect((await patch(db, { description: 'Changed again' })).description).toBe('Changed again');
      await db.exec(`INSERT INTO public.shortcut_inbox_match_reversals VALUES ('${decision}');`);
      expect((await patch(db, { description: 'Changed' })).description).toBe('Changed');
    } finally {
      await db.close();
    }
  });

  it('audits document metadata edits once and preserves linked evidence and balances', async () => {
    const db = await database();
    try {
      await db.exec(
        `INSERT INTO public.document_observation_decisions VALUES ('${owner}','${transaction}');`
      );
      const body = {
        category_id: null,
        description: 'Reviewed purchase',
        notes: 'Owner note',
        amount: 100,
        date: '2026-09-29',
        time: '12:00',
        account_id: source,
        type: 'expense'
      };
      expect((await patch(db, body)).category_id).toBeNull();
      await patch(db, body);
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM public.transaction_review_metadata_edits'
          )
        ).rows
      ).toEqual([{ count: 1 }]);
      expect((await db.query('SELECT * FROM public.document_observation_decisions')).rows).toEqual([
        { user_id: owner, transaction_id: transaction }
      ]);
      expect(await balances(db)).toEqual([
        { id: source, balance: '900.00' },
        { id: destination, balance: '1000.00' }
      ]);
      await expect(
        db.exec("UPDATE public.transaction_review_metadata_edits SET after_state='{}'::jsonb")
      ).rejects.toThrow(/append-only/i);
      await expect(db.exec('DELETE FROM public.transaction_review_metadata_edits')).rejects.toThrow(
        /append-only/i
      );
    } finally {
      await db.close();
    }
  });

  it('restricts audit reads to the owner and erases audit only with its transaction', async () => {
    const db = await database();
    try {
      await db.exec(
        `INSERT INTO public.document_observation_decisions VALUES ('${owner}','${transaction}');`
      );
      await patch(db, { notes: 'Reviewed note' });
      await db.exec(`SET request.jwt.claim.sub='${other}'; SET ROLE authenticated;`);
      expect(
        (await db.query('SELECT * FROM public.transaction_review_metadata_edits')).rows
      ).toEqual([]);
      await expect(
        db.exec(
          "INSERT INTO public.transaction_review_metadata_edits(user_id,transaction_id,before_state,after_state) VALUES (auth.uid(),gen_random_uuid(),'{}','{}')"
        )
      ).rejects.toThrow(/permission denied/i);
      await db.exec(`RESET ROLE; DELETE FROM public.transactions WHERE id='${transaction}';`);
      expect(
        (await db.query('SELECT * FROM public.transaction_review_metadata_edits')).rows
      ).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('audits active Shortcut metadata while accepting unchanged financial values and locking actual financial edits', async () => {
    const db = await database();
    try {
      const decision = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      await db.exec(
        `INSERT INTO public.shortcut_inbox_match_decisions VALUES ('${decision}','${owner}','${transaction}');`
      );
      const body = {
        category_id: null,
        description: 'Email purchase',
        notes: 'Owner note',
        amount: 100,
        date: '2026-09-29',
        time: '12:00',
        account_id: source,
        type: 'expense'
      };
      expect((await patch(db, body)).category_id).toBeNull();
      await patch(db, body);
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM public.transaction_review_metadata_edits'
          )
        ).rows
      ).toEqual([{ count: 1 }]);
      for (const change of [
        { amount: 101 },
        { date: '2026-09-30' },
        { time: '13:00' },
        { account_id: destination },
        { payment_method: 'card' }
      ]) {
        await expect(patch(db, change)).rejects.toThrow(/reviewed/i);
      }
      expect(await balances(db)).toEqual([
        { id: source, balance: '900.00' },
        { id: destination, balance: '1000.00' }
      ]);
      expect((await db.query('SELECT * FROM public.shortcut_inbox_match_decisions')).rows).toEqual([
        { id: decision, user_id: owner, transaction_id: transaction }
      ]);
    } finally {
      await db.close();
    }
  });

  it('blocks metadata mutation and audit reads until required terms are accepted', async () => {
    const db = await database();
    try {
      await db.exec(
        `INSERT INTO public.document_observation_decisions VALUES ('${owner}','${transaction}');`
      );
      await patch(db, { notes: 'Initial audited note' });
      await db.exec(
        `UPDATE auth.users SET raw_app_meta_data='{"anotto_terms_required":true}'::jsonb WHERE id='${owner}';`
      );
      await expect(patch(db, { notes: 'Unaccepted edit' })).rejects.toThrow(/terms/i);
      await db.exec(`SET request.jwt.claim.sub='${owner}'; SET ROLE authenticated;`);
      expect(
        (await db.query('SELECT * FROM public.transaction_review_metadata_edits')).rows
      ).toEqual([]);
      await db.query("SELECT public.accept_current_terms('2026-10-08')");
      expect(
        (await db.query('SELECT * FROM public.transaction_review_metadata_edits')).rows
      ).toHaveLength(1);
      await db.exec('RESET ROLE;');
      expect((await patch(db, { notes: 'Accepted edit' })).notes).toBe('Accepted edit');
    } finally {
      await db.close();
    }
  });

  it('keeps reviewed document financial fields locked and rejects foreign categories', async () => {
    const db = await database();
    try {
      await db.exec(
        `INSERT INTO public.document_observation_decisions VALUES ('${owner}','${transaction}');`
      );
      for (const body of [
        { amount: 101 },
        { date: '2026-09-30' },
        { time: '13:00' },
        { account_id: destination },
        { payment_method: 'card' }
      ]) {
        await expect(patch(db, body)).rejects.toThrow(/reviewed/i);
      }
      await expect(patch(db, { category_id: incomeCategory })).rejects.toThrow(/category/i);
      await expect(patch(db, { notes: 'Foreign' }, { user: other })).rejects.toThrow(/not found/i);
    } finally {
      await db.close();
    }
  });

  it('rejects deleted transactions and metadata-only edits do not touch balances', async () => {
    const db = await database();
    try {
      await patch(db, { notes: 'Reviewed note' });
      expect(await balances(db)).toEqual([
        { id: source, balance: '900.00' },
        { id: destination, balance: '1000.00' }
      ]);
      await db.exec(`UPDATE public.transactions SET deleted_at=now() WHERE id='${transaction}';`);
      await expect(patch(db, { notes: 'Later' })).rejects.toThrow(/not found/i);
    } finally {
      await db.close();
    }
  });
});
