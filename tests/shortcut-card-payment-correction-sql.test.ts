import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../supabase/migrations/20260929000260_shortcut_card_payment_correction.sql',
    import.meta.url
  ),
  'utf8'
);
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const savings = '33333333-3333-4333-8333-333333333333';
const card = '44444444-4444-4444-8444-444444444444';
const foreignCard = '55555555-5555-4555-8555-555555555555';
const expenseCategory = '66666666-6666-4666-8666-666666666666';
const transferCategory = '77777777-7777-4777-8777-777777777777';
const transaction = '88888888-8888-4888-8888-888888888888';
const inbox = '99999999-9999-4999-8999-999999999999';
const decision = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const request = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const notice =
  'Bancolombia: Pagaste $910,249 en la tarjeta de credito *4899 desde la cuenta *2651, el 03/08/2026 15:18. ¿Dudas? Llamanos al 018000912345. Estamos cerca.';
const evidence = {
  source: 'card_statement',
  document: '4899_AGO2026.pdf',
  sha256: '6c921c57e931ed8bdc2df9184ceb4ee189b6674f62de11b4a60296656e87ca99',
  page: 2,
  posting: '323723',
  date: '2026-08-03',
  amount: '910249.00'
};

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.accounts(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      balance numeric(15,2), type text NOT NULL, institution text, last_four text,
      bank_account_last_four text, is_active boolean DEFAULT true,
      deleted_at timestamptz);
    CREATE TABLE public.categories(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      type text NOT NULL, slug text, is_active boolean DEFAULT true,
      deleted_at timestamptz);
    CREATE TABLE public.transactions(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      account_id uuid NOT NULL, category_id uuid, amount numeric(15,2) NOT NULL,
      date date NOT NULL, time time NOT NULL, type text NOT NULL,
      transfer_to_account_id uuid, raw_text text, deleted_at timestamptz,
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
    CREATE TABLE public.shortcut_inbox_match_reversals(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL, inbox_item_id uuid NOT NULL, decision_id uuid NOT NULL);
    CREATE TABLE public.document_observation_decisions(user_id uuid NOT NULL,
      transaction_id uuid NOT NULL);
    INSERT INTO public.accounts VALUES
      ('${savings}','${owner}',10000000,'savings','Bancolombia','7799','2651',true,NULL),
      ('${card}','${owner}',-2000000,'credit_card','Bancolombia','4899',NULL,true,NULL),
      ('${foreignCard}','${other}',-300000,'credit_card','Bancolombia','4899',NULL,true,NULL);
    INSERT INTO public.categories VALUES
      ('${expenseCategory}','${owner}','expense','uncategorized',true,NULL),
      ('${transferCategory}','${owner}','transfer','transfer-between-accounts',true,NULL);
    INSERT INTO public.transactions(id,user_id,account_id,category_id,amount,date,time,type,raw_text)
      VALUES ('${transaction}','${owner}','${card}','${expenseCategory}',910249,
        '2026-08-03','15:18','expense','${notice}');
    INSERT INTO public.shortcut_inbox_items VALUES
      ('${inbox}','${owner}','matched','${notice}');
    INSERT INTO public.shortcut_inbox_match_decisions VALUES
      ('${decision}','${owner}','${inbox}','${transaction}','matched',
      '{"account_id":"${card}","amount":910249,"type":"expense"}');
  `);
  await db.exec(migration);
  return db;
}

async function correct(
  db: PGlite,
  options: {
    user?: string;
    requestId?: string;
    expectedAccount?: string;
    expectedAmount?: number;
    expectedCategory?: string;
    sourceAccount?: string;
    destinationAccount?: string;
    statementEvidence?: Record<string, unknown>;
  } = {}
): Promise<{ correction: Record<string, unknown>; replayed: boolean }> {
  await db.exec(`SET request.jwt.claim.sub = '${options.user ?? owner}'; SET ROLE authenticated;`);
  try {
    const result = await db.query<{
      correct_shortcut_card_payment: {
        correction: Record<string, unknown>;
        replayed: boolean;
      };
    }>(
      `SELECT public.correct_shortcut_card_payment(
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::numeric,$6::uuid,$7::date,$8::time,
        $9::uuid,$10::uuid,$11::uuid,$12::jsonb)`,
      [
        options.requestId ?? request,
        transaction,
        decision,
        options.expectedAccount ?? card,
        options.expectedAmount ?? 910249,
        options.expectedCategory ?? expenseCategory,
        '2026-08-03',
        '15:18',
        options.sourceAccount ?? savings,
        options.destinationAccount ?? card,
        transferCategory,
        JSON.stringify(options.statementEvidence ?? evidence)
      ]
    );
    return result.rows[0].correct_shortcut_card_payment;
  } finally {
    await db.exec('RESET ROLE;');
  }
}

async function state(db: PGlite): Promise<unknown> {
  return {
    accounts: (
      await db.query(`SELECT id,balance FROM public.accounts WHERE id IN ('${savings}','${card}')
        ORDER BY id`)
    ).rows,
    transaction: (
      await db.query(`SELECT type,account_id,transfer_to_account_id,category_id,amount
        FROM public.transactions WHERE id='${transaction}'`)
    ).rows[0],
    decision: (
      await db.query(`SELECT transaction_snapshot FROM public.shortcut_inbox_match_decisions
        WHERE id='${decision}'`)
    ).rows[0],
    corrections: (
      await db.query('SELECT count(*)::int AS count FROM public.shortcut_card_payment_corrections')
    ).rows[0]
  };
}

describe('audited Shortcut card-payment correction', () => {
  it('moves a statement-confirmed matched expense from card to savings-to-card transfer once', async () => {
    const db = await database();
    try {
      const first = await correct(db);
      expect(first.replayed).toBe(false);
      expect((await correct(db)).correction.id).toBe(first.correction.id);
      expect(await state(db)).toEqual({
        accounts: [
          { id: savings, balance: '9089751.00' },
          { id: card, balance: '-179502.00' }
        ],
        transaction: {
          type: 'transfer',
          account_id: savings,
          transfer_to_account_id: card,
          category_id: transferCategory,
          amount: '910249.00'
        },
        decision: {
          transaction_snapshot: { account_id: card, amount: 910249, type: 'expense' }
        },
        corrections: { count: 1 }
      });
    } finally {
      await db.close();
    }
  });

  it('adds only the destination leg when the old expense already debited savings', async () => {
    const db = await database();
    try {
      await db.exec(
        `UPDATE public.transactions SET account_id='${savings}' WHERE id='${transaction}'`
      );
      await correct(db, { expectedAccount: savings });
      const result = (await state(db)) as { accounts: { balance: string }[] };
      expect(result.accounts.map((account) => account.balance)).toEqual([
        '10000000.00',
        '-1089751.00'
      ]);
    } finally {
      await db.close();
    }
  });

  it('rejects altered notice facts and missing statement posting evidence', async () => {
    const db = await database();
    try {
      for (const altered of [
        notice.replace('$910,249', '$910,250'),
        notice.replace('*4899', '*8887'),
        notice.replace('*2651', '*2652'),
        notice.replace('03/08/2026', '04/08/2026'),
        notice.replace('15:18', '15:19')
      ]) {
        await db.query('UPDATE public.shortcut_inbox_items SET raw_text=$1 WHERE id=$2', [
          altered,
          inbox
        ]);
        await expect(correct(db)).rejects.toThrow(/notice|payment/i);
      }
      await db.query('UPDATE public.shortcut_inbox_items SET raw_text=$1 WHERE id=$2', [
        notice,
        inbox
      ]);
      await expect(
        correct(db, { statementEvidence: { ...evidence, posting: '' } })
      ).rejects.toThrow(/statement/i);
      await expect(
        correct(db, { statementEvidence: { ...evidence, amount: '910250.00' } })
      ).rejects.toThrow(/statement/i);
      await expect(
        correct(db, { statementEvidence: { ...evidence, date: '2026-08-04' } })
      ).rejects.toThrow(/statement/i);
      expect(((await state(db)) as { corrections: { count: number } }).corrections.count).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('rejects cross-owner accounts, stale expectations, and reused requests', async () => {
    const db = await database();
    try {
      await expect(correct(db, { destinationAccount: foreignCard })).rejects.toThrow();
      await expect(correct(db, { expectedAmount: 1 })).rejects.toThrow(/changed|stale/i);
      await correct(db);
      await expect(correct(db, { expectedAmount: 1 })).rejects.toThrow(/request/i);
      await expect(
        correct(db, { requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })
      ).rejects.toThrow(/expense|changed|stale/i);
      expect(((await state(db)) as { corrections: { count: number } }).corrections.count).toBe(1);
    } finally {
      await db.close();
    }
  });

  it('rejects reversed matches and a transaction with a reviewed document decision', async () => {
    const db = await database();
    try {
      await db.exec(`INSERT INTO public.shortcut_inbox_match_reversals
        (user_id,inbox_item_id,decision_id) VALUES ('${owner}','${inbox}','${decision}')`);
      await expect(correct(db)).rejects.toThrow(/match/i);
      await db.exec('DELETE FROM public.shortcut_inbox_match_reversals;');
      await db.exec(`INSERT INTO public.document_observation_decisions VALUES
        ('${owner}','${transaction}')`);
      await expect(correct(db)).rejects.toThrow(/document/i);
    } finally {
      await db.close();
    }
  });

  it('rolls back every financial and audit change when an account update fails', async () => {
    const db = await database();
    try {
      await db.exec(`CREATE FUNCTION reject_balance() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic account failure'; END $$;
        CREATE TRIGGER reject_balance BEFORE UPDATE ON public.accounts
        FOR EACH ROW EXECUTE FUNCTION reject_balance();`);
      await expect(correct(db)).rejects.toThrow(/synthetic account failure/);
      const result = (await state(db)) as {
        transaction: { type: string };
        corrections: { count: number };
      };
      expect(result.transaction.type).toBe('expense');
      expect(result.corrections.count).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('blocks match reversal and keeps audit rows owner-readable and append-only', async () => {
    const db = await database();
    try {
      await correct(db);
      await expect(
        db.exec(`INSERT INTO public.shortcut_inbox_match_reversals
          (user_id,inbox_item_id,decision_id) VALUES ('${owner}','${inbox}','${decision}')`)
      ).rejects.toThrow(/correction|undo/i);
      await expect(
        db.exec(`UPDATE public.shortcut_card_payment_corrections SET old_type='transfer'`)
      ).rejects.toThrow(/append-only/i);
      await db.exec(`SET request.jwt.claim.sub = '${other}'; SET ROLE authenticated;`);
      expect(
        (await db.query('SELECT id FROM public.shortcut_card_payment_corrections')).rows
      ).toEqual([]);
      await db.exec('RESET ROLE;');
      await db.exec(`BEGIN;
        SELECT set_config('app.shortcut_match_erasure','on',true);
        DELETE FROM public.transactions WHERE id='${transaction}';
        COMMIT;`);
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM public.shortcut_card_payment_corrections'
          )
        ).rows
      ).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });
});
