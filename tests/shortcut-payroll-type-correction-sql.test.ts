import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../supabase/migrations/20260929000190_shortcut_payroll_type_correction.sql',
    import.meta.url
  ),
  'utf8'
);
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const account = '33333333-3333-4333-8333-333333333333';
const foreignAccount = '44444444-4444-4444-8444-444444444444';
const wage = '55555555-5555-4555-8555-555555555555';
const food = '66666666-6666-4666-8666-666666666666';
const transaction = '77777777-7777-4777-8777-777777777777';
const inbox = '88888888-8888-4888-8888-888888888888';
const decision = '99999999-9999-4999-8999-999999999999';
const request = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const notice =
  'Bancolombia: Recibiste un pago de Nomina de CINCINNATI ASSO por $12,459,470.00 en tu cuenta de Ahorros el 28/04/2026 a las 17:21. Si tienes dudas, llamanos al 018000931987. A tu lado siempre.';

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.accounts(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      balance numeric(15,2), type text NOT NULL, is_active boolean DEFAULT true,
      deleted_at timestamptz);
    CREATE TABLE public.categories(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      type text NOT NULL, slug text NOT NULL, is_active boolean DEFAULT true,
      deleted_at timestamptz);
    CREATE TABLE public.transactions(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      account_id uuid NOT NULL, category_id uuid, amount numeric(15,2) NOT NULL,
      date date NOT NULL, time time NOT NULL,
      type text NOT NULL, transfer_to_account_id uuid, deleted_at timestamptz,
      updated_at timestamptz DEFAULT now(),
      CONSTRAINT transactions_id_user_unique UNIQUE(id,user_id));
    CREATE TABLE public.shortcut_inbox_items(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      status text NOT NULL, raw_text text NOT NULL,
      CONSTRAINT shortcut_inbox_owner_unique UNIQUE(id,user_id));
    CREATE TABLE public.shortcut_inbox_match_decisions(id uuid PRIMARY KEY,
      user_id uuid NOT NULL, inbox_item_id uuid NOT NULL, transaction_id uuid NOT NULL,
      decision_type text NOT NULL, transaction_snapshot jsonb NOT NULL,
      CONSTRAINT decision_owner_unique UNIQUE(id,user_id,transaction_id),
      FOREIGN KEY (transaction_id,user_id) REFERENCES public.transactions(id,user_id)
        ON DELETE CASCADE);
    CREATE TABLE public.shortcut_inbox_match_reversals(decision_id uuid UNIQUE);
    CREATE TABLE public.document_observation_decisions(user_id uuid NOT NULL,
      transaction_id uuid NOT NULL);
    INSERT INTO public.accounts VALUES
      ('${account}','${owner}',1000,'savings',true,NULL),
      ('${foreignAccount}','${other}',500,'savings',true,NULL);
    INSERT INTO public.categories VALUES
      ('${wage}','${owner}','income','wage',true,NULL),
      ('${food}','${owner}','expense','food',true,NULL);
    INSERT INTO public.transactions(id,user_id,account_id,category_id,amount,date,time,type)
      VALUES ('${transaction}','${owner}','${account}','${wage}',12459470,
        '2026-04-28','17:21','expense');
    INSERT INTO public.shortcut_inbox_items VALUES
      ('${inbox}','${owner}','matched','${notice}');
    INSERT INTO public.shortcut_inbox_match_decisions VALUES
      ('${decision}','${owner}','${inbox}','${transaction}','matched',
      '{"account_id":"${account}","amount":12459470,"type":"expense"}');
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
    expectedCategory?: string;
  } = {}
): Promise<{ correction: Record<string, unknown>; replayed: boolean }> {
  await db.exec(`SET request.jwt.claim.sub = '${options.user ?? owner}'; SET ROLE authenticated;`);
  try {
    const result = await db.query<{
      correct_shortcut_matched_payroll: {
        correction: Record<string, unknown>;
        replayed: boolean;
      };
    }>(
      `SELECT public.correct_shortcut_matched_payroll(
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::numeric,$6::uuid)`,
      [
        options.requestId ?? request,
        options.transactionId ?? transaction,
        options.decisionId ?? decision,
        options.expectedAccount ?? account,
        options.expectedAmount ?? 12459470,
        options.expectedCategory ?? wage
      ]
    );
    return result.rows[0].correct_shortcut_matched_payroll;
  } finally {
    await db.exec('RESET ROLE;');
  }
}

async function state(db: PGlite): Promise<unknown> {
  return {
    account: (await db.query(`SELECT balance FROM public.accounts WHERE id='${account}'`)).rows[0],
    transaction: (
      await db.query(`SELECT type,account_id,amount,category_id FROM public.transactions
        WHERE id='${transaction}'`)
    ).rows[0],
    decisions: (
      await db.query(`SELECT decision_type,transaction_snapshot
        FROM public.shortcut_inbox_match_decisions WHERE id='${decision}'`)
    ).rows,
    corrections: (
      await db.query('SELECT count(*)::int AS count FROM public.shortcut_payroll_type_corrections')
    ).rows[0]
  };
}

describe('audited Shortcut payroll type correction', () => {
  it('turns an explicitly incoming payroll expense into income exactly once', async () => {
    const db = await database();
    try {
      const first = await correct(db);
      expect(first.replayed).toBe(false);
      expect(first.correction.old_type).toBe('expense');
      expect(first.correction.new_type).toBe('income');
      expect((await correct(db)).correction.id).toBe(first.correction.id);
      expect(await state(db)).toEqual({
        account: { balance: '24919940.00' },
        transaction: {
          type: 'income',
          account_id: account,
          amount: '12459470.00',
          category_id: wage
        },
        decisions: [
          {
            decision_type: 'matched',
            transaction_snapshot: { account_id: account, amount: 12459470, type: 'expense' }
          }
        ],
        corrections: { count: 1 }
      });
    } finally {
      await db.close();
    }
  });

  it('requires the immutable linked notice to say incoming payroll', async () => {
    const db = await database();
    try {
      await db.exec(`UPDATE public.shortcut_inbox_items
        SET raw_text='Bancolombia: Compraste por $12,459,470' WHERE id='${inbox}';`);
      await expect(correct(db)).rejects.toThrow(/payroll|n[oó]mina/i);
      expect(((await state(db)) as { corrections: { count: number } }).corrections.count).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('requires the notice amount, savings-account wording, date, and time to match', async () => {
    const db = await database();
    try {
      for (const altered of [
        notice.replace('$12,459,470.00', '$12,459,471.00'),
        notice.replace('cuenta de Ahorros', 'tarjeta de Credito'),
        notice.replace('28/04/2026', '27/04/2026'),
        notice.replace('17:21', '17:22')
      ]) {
        await db.query(`UPDATE public.shortcut_inbox_items SET raw_text=$1 WHERE id=$2`, [
          altered,
          inbox
        ]);
        await expect(correct(db)).rejects.toThrow(/payroll|n[oó]mina|notice/i);
      }
      expect(((await state(db)) as { corrections: { count: number } }).corrections.count).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('rejects stale account, amount, category, and reused request IDs', async () => {
    const db = await database();
    try {
      await expect(correct(db, { expectedAmount: 1 })).rejects.toThrow(/changed|stale/i);
      await expect(correct(db, { expectedAccount: foreignAccount })).rejects.toThrow(
        /changed|stale/i
      );
      await expect(correct(db, { expectedCategory: food })).rejects.toThrow(/changed|stale/i);
      await correct(db);
      await expect(correct(db, { expectedAmount: 1 })).rejects.toThrow(/request/i);
      await expect(
        correct(db, { requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })
      ).rejects.toThrow(/expense|changed|stale/i);
      expect(((await state(db)) as { corrections: { count: number } }).corrections.count).toBe(1);
    } finally {
      await db.close();
    }
  });

  it('rejects cross-owner access, reversed matches, and non-wage categories', async () => {
    const db = await database();
    try {
      await expect(correct(db, { user: other })).rejects.toThrow();
      await db.exec(`INSERT INTO public.shortcut_inbox_match_reversals VALUES ('${decision}');`);
      await expect(correct(db)).rejects.toThrow(/match/i);
      await db.exec('DELETE FROM public.shortcut_inbox_match_reversals;');
      await db.exec(
        `UPDATE public.transactions SET category_id='${food}' WHERE id='${transaction}';`
      );
      await expect(correct(db, { expectedCategory: food })).rejects.toThrow(/wage|category/i);
    } finally {
      await db.close();
    }
  });

  it('rejects a competing request from the same expected state', async () => {
    const db = await database();
    try {
      const results = await Promise.allSettled([
        correct(db),
        correct(db, { requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(((await state(db)) as { corrections: { count: number } }).corrections.count).toBe(1);
    } finally {
      await db.close();
    }
  });

  it('rolls back transaction, account, and audit when the balance update fails', async () => {
    const db = await database();
    try {
      await db.exec(`CREATE FUNCTION reject_balance() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic account failure'; END $$;
        CREATE TRIGGER reject_balance BEFORE UPDATE ON public.accounts
        FOR EACH ROW EXECUTE FUNCTION reject_balance();`);
      await expect(correct(db)).rejects.toThrow(/synthetic account failure/);
      expect(
        ((await state(db)) as { transaction: { type: string }; corrections: { count: number } })
          .transaction.type
      ).toBe('expense');
      expect(((await state(db)) as { corrections: { count: number } }).corrections.count).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('keeps audit rows append-only, owner-readable, and erasable with the transaction', async () => {
    const db = await database();
    try {
      await correct(db);
      await expect(
        db.exec(`UPDATE public.shortcut_payroll_type_corrections SET new_type='expense'`)
      ).rejects.toThrow(/append-only/i);
      await db.exec(`SET request.jwt.claim.sub = '${other}'; SET ROLE authenticated;`);
      expect(
        (await db.query('SELECT id FROM public.shortcut_payroll_type_corrections')).rows
      ).toEqual([]);
      await db.exec('RESET ROLE;');
      await db.exec(`BEGIN;
        SELECT set_config('app.shortcut_match_erasure','on',true);
        DELETE FROM public.transactions WHERE id='${transaction}';
        COMMIT;`);
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM public.shortcut_payroll_type_corrections'
          )
        ).rows
      ).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });
});
