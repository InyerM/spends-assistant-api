import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../supabase/migrations/20260929000230_shortcut_incoming_type_correction.sql',
    import.meta.url
  ),
  'utf8'
);
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const account = '33333333-3333-4333-8333-333333333333';
const foreignAccount = '44444444-4444-4444-8444-444444444444';
const transaction = '55555555-5555-4555-8555-555555555555';
const inbox = '66666666-6666-4666-8666-666666666666';
const decision = '77777777-7777-4777-8777-777777777777';
const request = '88888888-8888-4888-8888-888888888888';
const notice =
  'Bancolombia: INYER, recibiste una transferencia de YONATTAN ALEXANDER MARIN MEDINA por $100,000.00 en tu cuenta *2651 conectada a la llave 3195963135 el 19/05/26 a las 08:38. Con llaves es mas facil.';

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.accounts(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      balance numeric(15,2), type text NOT NULL, institution text,
      last_four text, is_active boolean DEFAULT true, deleted_at timestamptz);
    CREATE TABLE public.transactions(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      account_id uuid NOT NULL, category_id uuid, amount numeric(15,2) NOT NULL,
      date date NOT NULL, time time NOT NULL, type text NOT NULL,
      transfer_to_account_id uuid, deleted_at timestamptz,
      updated_at timestamptz DEFAULT now(),
      CONSTRAINT transactions_id_user_unique UNIQUE(id,user_id));
    CREATE TABLE public.shortcut_inbox_items(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      status text NOT NULL, raw_text text NOT NULL,
      CONSTRAINT shortcut_inbox_owner_unique UNIQUE(id,user_id));
    CREATE TABLE public.shortcut_inbox_match_decisions(id uuid PRIMARY KEY,
      user_id uuid NOT NULL, inbox_item_id uuid NOT NULL, transaction_id uuid NOT NULL,
      decision_type text NOT NULL, transaction_snapshot jsonb NOT NULL,
      CONSTRAINT decision_owner_unique UNIQUE(id,user_id,transaction_id),
      CONSTRAINT decision_owner_item_unique UNIQUE(id,user_id,inbox_item_id),
      FOREIGN KEY (transaction_id,user_id) REFERENCES public.transactions(id,user_id)
        ON DELETE CASCADE);
    CREATE TABLE public.shortcut_inbox_match_reversals(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL, inbox_item_id uuid NOT NULL, decision_id uuid UNIQUE NOT NULL,
      FOREIGN KEY (decision_id,user_id,inbox_item_id)
        REFERENCES public.shortcut_inbox_match_decisions(id,user_id,inbox_item_id)
        ON DELETE CASCADE);
    CREATE TABLE public.shortcut_transaction_financial_corrections(
      user_id uuid NOT NULL, transaction_id uuid NOT NULL, match_decision_id uuid NOT NULL);
    CREATE TABLE public.shortcut_payroll_type_corrections(
      user_id uuid NOT NULL, transaction_id uuid NOT NULL, match_decision_id uuid NOT NULL);
    CREATE TABLE public.document_observation_decisions(user_id uuid NOT NULL,
      transaction_id uuid NOT NULL);
    INSERT INTO public.accounts VALUES
      ('${account}','${owner}',900000,'savings','Bancolombia','2651',true,NULL),
      ('${foreignAccount}','${other}',500000,'savings','Bancolombia','2651',true,NULL);
    INSERT INTO public.transactions(id,user_id,account_id,category_id,amount,date,time,type)
      VALUES ('${transaction}','${owner}','${account}',NULL,100000,
        '2026-05-19','08:38','expense');
    INSERT INTO public.shortcut_inbox_items VALUES
      ('${inbox}','${owner}','matched','${notice}');
    INSERT INTO public.shortcut_inbox_match_decisions VALUES
      ('${decision}','${owner}','${inbox}','${transaction}','matched',
      '{"account_id":"${account}","amount":100000,"type":"expense"}');
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
    expectedDate?: string;
    expectedTime?: string;
    role?: string;
  } = {}
): Promise<{ correction: Record<string, unknown>; replayed: boolean }> {
  await db.exec(`SET request.jwt.claim.sub = '${options.user ?? owner}'; SET ROLE authenticated;`);
  try {
    const result = await db.query<{
      correct_shortcut_matched_incoming_transfer: {
        correction: Record<string, unknown>;
        replayed: boolean;
      };
    }>(
      `SELECT public.correct_shortcut_matched_incoming_transfer(
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::numeric,$6::date,$7::time,
        $8::public.shortcut_incoming_flow_role)`,
      [
        options.requestId ?? request,
        options.transactionId ?? transaction,
        options.decisionId ?? decision,
        options.expectedAccount ?? account,
        options.expectedAmount ?? 100000,
        options.expectedDate ?? '2026-05-19',
        options.expectedTime ?? '08:38',
        options.role ?? 'receivable_principal_repayment'
      ]
    );
    return result.rows[0].correct_shortcut_matched_incoming_transfer;
  } finally {
    await db.exec('RESET ROLE;');
  }
}

async function state(db: PGlite): Promise<unknown> {
  return {
    account: (await db.query(`SELECT balance FROM public.accounts WHERE id='${account}'`)).rows[0],
    transaction: (
      await db.query(`SELECT type,account_id,amount,category_id,
        to_char(date,'YYYY-MM-DD') AS date,time
        FROM public.transactions WHERE id='${transaction}'`)
    ).rows[0],
    decisions: (
      await db.query(`SELECT decision_type,transaction_snapshot
        FROM public.shortcut_inbox_match_decisions WHERE id='${decision}'`)
    ).rows,
    corrections: (
      await db.query('SELECT count(*)::int AS count FROM public.shortcut_incoming_type_corrections')
    ).rows[0]
  };
}

describe('audited Shortcut incoming transfer correction', () => {
  it.each([
    'receivable_principal_repayment',
    'personal_sale_proceeds',
    'earmarked_relief_donation'
  ])('corrects exact incoming SMS and records reviewed role %s only once', async (role) => {
    const db = await database();
    try {
      const first = await correct(db, { role });
      expect(first.replayed).toBe(false);
      expect(first.correction.flow_role).toBe(role);
      expect(first.correction.old_type).toBe('expense');
      expect(first.correction.new_type).toBe('income');
      const replay = await correct(db, { role });
      expect(replay.replayed).toBe(true);
      expect(replay.correction.id).toBe(first.correction.id);
      expect(await state(db)).toEqual({
        account: { balance: '1100000.00' },
        transaction: {
          type: 'income',
          account_id: account,
          amount: '100000.00',
          category_id: null,
          date: '2026-05-19',
          time: '08:38:00'
        },
        decisions: [
          {
            decision_type: 'matched',
            transaction_snapshot: { account_id: account, amount: 100000, type: 'expense' }
          }
        ],
        corrections: { count: 1 }
      });
    } finally {
      await db.close();
    }
  });

  it('requires the immutable notice to explicitly say an incoming transfer', async () => {
    const db = await database();
    try {
      await db.exec(`UPDATE public.shortcut_inbox_items
        SET raw_text='Bancolombia: INYER, hiciste una transferencia por $100,000.00'
        WHERE id='${inbox}';`);
      await expect(correct(db)).rejects.toThrow(/notice|incoming/i);
      expect(((await state(db)) as { corrections: { count: number } }).corrections.count).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('requires exact amount, account suffix, original date, and time', async () => {
    const db = await database();
    try {
      for (const altered of [
        notice.replace('$100,000.00', '$100,001.00'),
        notice.replace('*2651', '*9999'),
        notice.replace('19/05/26', '20/05/26'),
        notice.replace('08:38', '08:39')
      ]) {
        await db.query(`UPDATE public.shortcut_inbox_items SET raw_text=$1 WHERE id=$2`, [
          altered,
          inbox
        ]);
        await expect(correct(db)).rejects.toThrow(/notice|incoming/i);
      }
      expect(((await state(db)) as { corrections: { count: number } }).corrections.count).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('rejects stale reviewed state and a request ID reused with another role', async () => {
    const db = await database();
    try {
      await expect(correct(db, { expectedAccount: foreignAccount })).rejects.toThrow(/changed/);
      await expect(correct(db, { expectedAmount: 1 })).rejects.toThrow(/changed/);
      await expect(correct(db, { expectedDate: '2026-05-20' })).rejects.toThrow(/changed/);
      await expect(correct(db, { expectedTime: '08:39' })).rejects.toThrow(/changed/);
      await correct(db);
      await expect(correct(db, { role: 'personal_sale_proceeds' })).rejects.toThrow(/request_id/);
      await expect(
        correct(db, { requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
      ).rejects.toThrow(/expense|changed/i);
    } finally {
      await db.close();
    }
  });

  it('rejects foreign owner, reversed match, non-savings account, and categorized row', async () => {
    const db = await database();
    try {
      await expect(correct(db, { user: other })).rejects.toThrow();
      await db.exec(`INSERT INTO public.shortcut_inbox_match_reversals
        (user_id,inbox_item_id,decision_id) VALUES ('${owner}','${inbox}','${decision}');`);
      await expect(correct(db)).rejects.toThrow(/match/);
      await db.exec('DELETE FROM public.shortcut_inbox_match_reversals;');
      await db.exec(`UPDATE public.accounts SET type='credit_card' WHERE id='${account}';`);
      await expect(correct(db)).rejects.toThrow(/savings/i);
      await db.exec(`UPDATE public.accounts SET type='savings' WHERE id='${account}';`);
      await db.exec(`UPDATE public.transactions SET category_id='${foreignAccount}'
        WHERE id='${transaction}';`);
      await expect(correct(db)).rejects.toThrow(/uncategorized|category/i);
    } finally {
      await db.close();
    }
  });

  it('allows only one competing correction for the reviewed expense state', async () => {
    const db = await database();
    try {
      const results = await Promise.allSettled([
        correct(db),
        correct(db, { requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(((await state(db)) as { corrections: { count: number } }).corrections.count).toBe(1);
    } finally {
      await db.close();
    }
  });

  it('rolls back all writes if the account balance update fails', async () => {
    const db = await database();
    try {
      await db.exec(`CREATE FUNCTION reject_balance() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic account failure'; END $$;
        CREATE TRIGGER reject_balance BEFORE UPDATE ON public.accounts
        FOR EACH ROW EXECUTE FUNCTION reject_balance();`);
      await expect(correct(db)).rejects.toThrow(/synthetic account failure/);
      expect((await state(db)) as { transaction: { type: string } }).toMatchObject({
        account: { balance: '900000.00' },
        transaction: { type: 'expense' },
        corrections: { count: 0 }
      });
    } finally {
      await db.close();
    }
  });

  it('keeps the audit owner-readable, append-only, and subject to hard erasure', async () => {
    const db = await database();
    try {
      await correct(db);
      await expect(
        db.exec(`UPDATE public.shortcut_incoming_type_corrections
          SET flow_role='personal_sale_proceeds'`)
      ).rejects.toThrow(/append-only/i);
      await db.exec(`SET request.jwt.claim.sub = '${other}'; SET ROLE authenticated;`);
      expect(
        (await db.query('SELECT id FROM public.shortcut_incoming_type_corrections')).rows
      ).toEqual([]);
      await db.exec('RESET ROLE;');
      await db.exec(`BEGIN;
        SELECT set_config('app.shortcut_match_erasure','on',true);
        DELETE FROM public.transactions WHERE id='${transaction}';
        COMMIT;`);
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM public.shortcut_incoming_type_corrections'
          )
        ).rows
      ).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });

  it('blocks reversal of a live incoming correction without changing its audit', async () => {
    const db = await database();
    try {
      await correct(db);
      await expect(
        db.exec(`INSERT INTO public.shortcut_inbox_match_reversals
          (user_id,inbox_item_id,decision_id) VALUES ('${owner}','${inbox}','${decision}');`)
      ).rejects.toThrow(/audited|correction/i);
      expect((await db.query('SELECT * FROM public.shortcut_inbox_match_reversals')).rows).toEqual(
        []
      );
      expect(((await state(db)) as { corrections: { count: number } }).corrections.count).toBe(1);
    } finally {
      await db.close();
    }
  });

  it.each(['shortcut_transaction_financial_corrections', 'shortcut_payroll_type_corrections'])(
    'blocks reversal of a live %s audit',
    async (table) => {
      const db = await database();
      try {
        await db.exec(
          `INSERT INTO public.${table} VALUES ('${owner}','${transaction}','${decision}');`
        );
        await expect(
          db.exec(`INSERT INTO public.shortcut_inbox_match_reversals
          (user_id,inbox_item_id,decision_id) VALUES ('${owner}','${inbox}','${decision}');`)
        ).rejects.toThrow(/audited|correction/i);
      } finally {
        await db.close();
      }
    }
  );

  it('lets an inactive corrected transaction be reversed, but rejects foreign ownership', async () => {
    const db = await database();
    try {
      await correct(db);
      await expect(
        db.exec(`INSERT INTO public.shortcut_inbox_match_reversals
          (user_id,inbox_item_id,decision_id) VALUES ('${other}','${inbox}','${decision}');`)
      ).rejects.toThrow(/foreign key/i);
      await db.exec(`UPDATE public.transactions SET deleted_at=now() WHERE id='${transaction}';`);
      await db.exec(`INSERT INTO public.shortcut_inbox_match_reversals
        (user_id,inbox_item_id,decision_id) VALUES ('${owner}','${inbox}','${decision}');`);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.shortcut_inbox_match_reversals'))
          .rows
      ).toEqual([{ count: 1 }]);
    } finally {
      await db.close();
    }
  });
});
