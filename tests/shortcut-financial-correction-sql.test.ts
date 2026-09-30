import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../supabase/migrations/20260929000170_shortcut_financial_correction.sql',
    import.meta.url
  ),
  'utf8'
);
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const credit = '33333333-3333-4333-8333-333333333333';
const savings = '44444444-4444-4444-8444-444444444444';
const foreignAccount = '55555555-5555-4555-8555-555555555555';
const transaction = '66666666-6666-4666-8666-666666666666';
const otherTransaction = '77777777-7777-4777-8777-777777777777';
const inbox = '88888888-8888-4888-8888-888888888888';
const decision = '99999999-9999-4999-8999-999999999999';
const request = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const evidence = {
  source: 'bank_statement',
  document: 'Q2 savings statement',
  page: 3,
  line: 'synthetic-posting'
};

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.accounts(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      balance numeric(15,2), is_active boolean DEFAULT true, deleted_at timestamptz);
    CREATE TABLE public.transactions(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      account_id uuid NOT NULL, amount numeric(15,2) NOT NULL, type text NOT NULL,
      transfer_to_account_id uuid, deleted_at timestamptz, updated_at timestamptz DEFAULT now(),
      CONSTRAINT transactions_id_user_unique UNIQUE(id,user_id));
    CREATE TABLE public.shortcut_inbox_items(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      status text NOT NULL);
    CREATE TABLE public.shortcut_inbox_match_decisions(id uuid PRIMARY KEY,
      user_id uuid NOT NULL, inbox_item_id uuid NOT NULL, transaction_id uuid NOT NULL,
      decision_type text NOT NULL, transaction_snapshot jsonb NOT NULL,
      CONSTRAINT decision_owner_unique UNIQUE(id,user_id,transaction_id),
      FOREIGN KEY (transaction_id,user_id) REFERENCES public.transactions(id,user_id)
        ON DELETE CASCADE);
    CREATE TABLE public.shortcut_inbox_match_reversals(decision_id uuid UNIQUE);
    CREATE TABLE public.document_observation_decisions(user_id uuid NOT NULL,
      transaction_id uuid NOT NULL);
    INSERT INTO auth.users VALUES ('${owner}'),('${other}');
    INSERT INTO public.accounts VALUES
      ('${credit}','${owner}',900,true,NULL),
      ('${savings}','${owner}',1000,true,NULL),
      ('${foreignAccount}','${other}',500,true,NULL);
    INSERT INTO public.transactions(id,user_id,account_id,amount,type) VALUES
      ('${transaction}','${owner}','${credit}',100,'expense'),
      ('${otherTransaction}','${other}','${foreignAccount}',50,'expense');
    INSERT INTO public.shortcut_inbox_items VALUES ('${inbox}','${owner}','matched');
    INSERT INTO public.shortcut_inbox_match_decisions VALUES
      ('${decision}','${owner}','${inbox}','${transaction}','matched',
      '{"account_id":"${credit}","amount":100}');
  `);
  await db.exec(migration);
  return db;
}

async function correct(
  db: PGlite,
  options: {
    user?: string;
    requestId?: string;
    transactionId?: string;
    decisionId?: string;
    expectedAccount?: string;
    expectedAmount?: number;
    newAccount?: string;
    newAmount?: number | null;
    evidence?: Record<string, unknown>;
  } = {}
): Promise<{ correction: Record<string, unknown>; replayed: boolean }> {
  await db.exec(`SET request.jwt.claim.sub = '${options.user ?? owner}'; SET ROLE authenticated;`);
  try {
    const result = await db.query<{
      correct_shortcut_matched_expense: { correction: Record<string, unknown>; replayed: boolean };
    }>(
      `SELECT public.correct_shortcut_matched_expense(
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::numeric,$6::uuid,$7::numeric,$8::jsonb)`,
      [
        options.requestId ?? request,
        options.transactionId ?? transaction,
        options.decisionId ?? decision,
        options.expectedAccount ?? credit,
        options.expectedAmount ?? 100,
        options.newAccount ?? savings,
        options.newAmount === undefined ? null : options.newAmount,
        JSON.stringify(options.evidence ?? evidence)
      ]
    );
    return result.rows[0].correct_shortcut_matched_expense;
  } finally {
    await db.exec('RESET ROLE;');
  }
}

async function balances(db: PGlite): Promise<unknown[]> {
  return (
    await db.query(`SELECT id,balance FROM public.accounts
    WHERE id IN ('${credit}','${savings}') ORDER BY id`)
  ).rows;
}

describe('audited Shortcut financial correction', () => {
  it('moves an expense to the verified account and adjusts a settled amount once', async () => {
    const db = await database();
    try {
      const first = await correct(db, { newAmount: 150.25 });
      expect(first.replayed).toBe(false);
      expect(first.correction.old_amount).toBe(100);
      expect(first.correction.new_amount).toBe(150.25);
      expect((await correct(db, { newAmount: 150.25 })).correction.id).toBe(first.correction.id);
      expect(await balances(db)).toEqual([
        { id: credit, balance: '1000.00' },
        { id: savings, balance: '849.75' }
      ]);
      expect(
        (
          await db.query(`SELECT account_id,amount FROM public.transactions
        WHERE id='${transaction}'`)
        ).rows
      ).toEqual([{ account_id: savings, amount: '150.25' }]);
      expect(
        (
          await db.query(`SELECT transaction_snapshot FROM public.shortcut_inbox_match_decisions
        WHERE id='${decision}'`)
        ).rows
      ).toEqual([{ transaction_snapshot: { account_id: credit, amount: 100 } }]);
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM public.shortcut_transaction_financial_corrections'
          )
        ).rows
      ).toEqual([{ count: 1 }]);
    } finally {
      await db.close();
    }
  });

  it('keeps the original amount when no settled amount is supplied', async () => {
    const db = await database();
    try {
      await correct(db);
      expect(await balances(db)).toEqual([
        { id: credit, balance: '1000.00' },
        { id: savings, balance: '900.00' }
      ]);
      expect(
        (await db.query(`SELECT amount FROM public.transactions WHERE id='${transaction}'`)).rows
      ).toEqual([{ amount: '100.00' }]);
    } finally {
      await db.close();
    }
  });

  it('rejects stale expectations, reused request IDs with changed input, and cross-owner changes', async () => {
    const db = await database();
    try {
      await expect(correct(db, { user: other })).rejects.toThrow();
      await expect(correct(db, { transactionId: otherTransaction })).rejects.toThrow();
      await expect(correct(db, { newAccount: foreignAccount })).rejects.toThrow();
      await expect(correct(db, { expectedAmount: 101 })).rejects.toThrow(/changed|stale/i);
      await correct(db);
      await expect(correct(db, { newAmount: 200 })).rejects.toThrow(/request/i);
      await expect(
        correct(db, { requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })
      ).rejects.toThrow(/changed|stale/i);
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM public.shortcut_transaction_financial_corrections'
          )
        ).rows
      ).toEqual([{ count: 1 }]);
    } finally {
      await db.close();
    }
  });

  it('requires an active match and documented evidence, and rejects incompatible transactions', async () => {
    const db = await database();
    try {
      await expect(correct(db, { evidence: {} })).rejects.toThrow(/evidence/i);
      await db.exec(`INSERT INTO public.shortcut_inbox_match_reversals VALUES ('${decision}');`);
      await expect(correct(db)).rejects.toThrow(/match/i);
      await db.exec('DELETE FROM public.shortcut_inbox_match_reversals;');
      await db.exec(`UPDATE public.transactions SET type='transfer' WHERE id='${transaction}';`);
      await expect(correct(db)).rejects.toThrow(/expense/i);
      await db.exec(`UPDATE public.transactions SET type='expense' WHERE id='${transaction}';`);
      await db.exec(
        `INSERT INTO public.document_observation_decisions VALUES ('${owner}','${transaction}');`
      );
      await expect(correct(db)).rejects.toThrow(/document/i);
    } finally {
      await db.close();
    }
  });

  it('rolls back the transaction and audit record when a balance update fails', async () => {
    const db = await database();
    try {
      await db.exec(`CREATE FUNCTION reject_balance() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic account failure'; END $$;
        CREATE TRIGGER reject_balance BEFORE UPDATE ON public.accounts
        FOR EACH ROW EXECUTE FUNCTION reject_balance();`);
      await expect(correct(db)).rejects.toThrow(/synthetic account failure/);
      expect(
        (
          await db.query(`SELECT account_id,amount FROM public.transactions
        WHERE id='${transaction}'`)
        ).rows
      ).toEqual([{ account_id: credit, amount: '100.00' }]);
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM public.shortcut_transaction_financial_corrections'
          )
        ).rows
      ).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });

  it('rejects a competing correction with the same expected state', async () => {
    const db = await database();
    try {
      const result = await Promise.allSettled([
        correct(db, { requestId: request }),
        correct(db, { requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })
      ]);
      expect(result.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
      expect(result.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
      expect(await balances(db)).toEqual([
        { id: credit, balance: '1000.00' },
        { id: savings, balance: '900.00' }
      ]);
    } finally {
      await db.close();
    }
  });

  it('preserves append-only audit rows and scopes their reads to the owner', async () => {
    const db = await database();
    try {
      await correct(db);
      await expect(
        db.exec(`UPDATE public.shortcut_transaction_financial_corrections
        SET new_amount=1 WHERE request_id='${request}'`)
      ).rejects.toThrow(/append-only/i);
      await expect(
        db.exec(`DELETE FROM public.shortcut_transaction_financial_corrections
        WHERE request_id='${request}'`)
      ).rejects.toThrow(/append-only/i);
      await db.exec(`SET request.jwt.claim.sub = '${other}'; SET ROLE authenticated;`);
      try {
        expect(
          (await db.query('SELECT id FROM public.shortcut_transaction_financial_corrections')).rows
        ).toEqual([]);
      } finally {
        await db.exec('RESET ROLE;');
      }
      await db.exec(`SET request.jwt.claim.sub = '${owner}'; SET ROLE authenticated;`);
      try {
        expect(
          (await db.query('SELECT id FROM public.shortcut_transaction_financial_corrections')).rows
        ).toHaveLength(1);
      } finally {
        await db.exec('RESET ROLE;');
      }
    } finally {
      await db.close();
    }
  });

  it('allows a subsequent correction only with the newly expected financial state', async () => {
    const db = await database();
    try {
      await correct(db, { newAmount: 150.25 });
      const next = await correct(db, {
        requestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        expectedAccount: savings,
        expectedAmount: 150.25,
        newAccount: credit,
        newAmount: 100
      });
      expect(next.correction.old_account_id).toBe(savings);
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM public.shortcut_transaction_financial_corrections'
          )
        ).rows
      ).toEqual([{ count: 2 }]);
      expect(await balances(db)).toEqual([
        { id: credit, balance: '900.00' },
        { id: savings, balance: '1000.00' }
      ]);
    } finally {
      await db.close();
    }
  });

  it('erases correction evidence when the transaction is hard-deleted for privacy', async () => {
    const db = await database();
    try {
      await correct(db);
      await db.exec(`BEGIN;
        SELECT set_config('app.shortcut_match_erasure','on',true);
        DELETE FROM public.transactions WHERE id='${transaction}';
        COMMIT;`);
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM public.shortcut_transaction_financial_corrections'
          )
        ).rows
      ).toEqual([{ count: 0 }]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.shortcut_inbox_match_decisions'))
          .rows
      ).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });
});
