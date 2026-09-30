import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../supabase/migrations/20260929000240_shortcut_card_refund_correction.sql',
    import.meta.url
  ),
  'utf8'
);
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const account = '7d46c20e-5a80-4e2f-9a16-6a05a6da6c3e';
const transaction = '9afa26b4-1269-4fe4-bcac-ce01404819f5';
const category = '33333333-3333-4333-8333-333333333333';
const inbox = '44444444-4444-4444-8444-444444444444';
const decision = '55555555-5555-4555-8555-555555555555';
const request = '66666666-6666-4666-8666-666666666666';
const archiveHash = 'f86f89479dbb2278764d066c614cdb423759b640cbaaab3190f5d0b02f52b7e4';
const notice =
  'Bancolombia: Recibiste la devolucion de $89,991.00 por MERCADO PAGO LIMITADA en tu tarjeta de credito *0265, el 04:59 a las 28/05/2026. ¿Dudas? Llamanos al 018000931987. Estamos cerca';

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
    CREATE TABLE public.categories(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      type text NOT NULL, slug text NOT NULL, is_active boolean NOT NULL,
      deleted_at timestamptz);
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
      FOREIGN KEY (transaction_id,user_id) REFERENCES public.transactions(id,user_id)
        ON DELETE CASCADE);
    CREATE TABLE public.shortcut_inbox_match_reversals(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL, inbox_item_id uuid NOT NULL, decision_id uuid UNIQUE NOT NULL);
    CREATE TABLE public.document_observation_decisions(user_id uuid NOT NULL,
      transaction_id uuid NOT NULL);
    CREATE TABLE public.shortcut_transaction_financial_corrections(
      user_id uuid NOT NULL, transaction_id uuid NOT NULL);
    CREATE TABLE public.shortcut_payroll_type_corrections(
      user_id uuid NOT NULL, transaction_id uuid NOT NULL);
    CREATE TABLE public.shortcut_incoming_type_corrections(
      user_id uuid NOT NULL, transaction_id uuid NOT NULL);
    INSERT INTO public.accounts VALUES
      ('${account}','${owner}',-100000,'credit_card','Bancolombia','0265',true,NULL);
    INSERT INTO public.categories VALUES
      ('${category}','${owner}','income','refunds',true,NULL);
    INSERT INTO public.transactions(id,user_id,account_id,category_id,amount,date,time,type)
      VALUES ('${transaction}','${owner}','${account}','${category}',89991,
        '2026-05-28','04:59','expense');
    INSERT INTO public.shortcut_inbox_items VALUES
      ('${inbox}','${owner}','matched','${notice}');
    INSERT INTO public.shortcut_inbox_match_decisions VALUES
      ('${decision}','${owner}','${inbox}','${transaction}','matched',
      '{"account_id":"${account}","amount":89991,"date":"2026-05-28","type":"expense"}');
  `);
  await db.exec(migration);
  return db;
}

type Options = Partial<{
  user: string;
  requestId: string;
  transactionId: string;
  decisionId: string;
  accountId: string;
  amount: number;
  categoryId: string;
  date: string;
  time: string;
  reference: string;
  statementDate: string;
  statementAmount: number;
  archiveHash: string;
  reviewed: boolean;
}>;

async function correct(
  db: PGlite,
  options: Options = {}
): Promise<{ correction: Record<string, unknown>; replayed: boolean }> {
  await db.exec(`SET request.jwt.claim.sub = '${options.user ?? owner}'; SET ROLE authenticated;`);
  try {
    const result = await db.query<{
      correct_shortcut_card_refund: { correction: Record<string, unknown>; replayed: boolean };
    }>(
      `SELECT public.correct_shortcut_card_refund(
      $1::uuid,$2::boolean,$3::uuid,$4::uuid,$5::uuid,$6::numeric,
      $7::uuid,$8::date,$9::time,$10::text,$11::date,$12::numeric,$13::text)`,
      [
        options.requestId ?? request,
        options.reviewed ?? true,
        options.transactionId ?? transaction,
        options.decisionId ?? decision,
        options.accountId ?? account,
        options.amount ?? 89991,
        options.categoryId ?? category,
        options.date ?? '2026-05-28',
        options.time ?? '04:59',
        options.reference ?? 'T05840',
        options.statementDate ?? '2026-05-26',
        options.statementAmount ?? -89991,
        options.archiveHash ?? archiveHash
      ]
    );
    return result.rows[0].correct_shortcut_card_refund;
  } finally {
    await db.exec('RESET ROLE;');
  }
}

async function state(db: PGlite): Promise<unknown> {
  return {
    account: (await db.query(`SELECT balance FROM public.accounts WHERE id='${account}'`)).rows[0],
    transaction: (await db.query(`SELECT type FROM public.transactions WHERE id='${transaction}'`))
      .rows[0],
    audit: (
      await db.query('SELECT count(*)::int AS count FROM public.shortcut_card_refund_corrections')
    ).rows[0]
  };
}

describe('reviewed Mastercard refund correction', () => {
  it('changes the direction once, preserves the original match, and records statement evidence', async () => {
    const db = await database();
    try {
      const first = await correct(db);
      expect(first.replayed).toBe(false);
      expect(first.correction.statement_reference).toBe('T05840');
      expect(first.correction.statement_archive_sha256).toBe(archiveHash);
      const replay = await correct(db);
      expect(replay.replayed).toBe(true);
      expect(replay.correction.id).toBe(first.correction.id);
      expect(await state(db)).toEqual({
        account: { balance: '79982.00' },
        transaction: { type: 'income' },
        audit: { count: 1 }
      });
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.shortcut_inbox_match_decisions'))
          .rows[0]
      ).toEqual({ count: 1 });
    } finally {
      await db.close();
    }
  });

  it.each([
    ['different owner', { user: other }],
    ['different account', { accountId: other }],
    ['stale amount', { amount: 89990 }],
    ['wrong statement reference', { reference: 'T05841' }],
    ['wrong statement date', { statementDate: '2026-05-28' }],
    ['wrong statement sign', { statementAmount: 89991 }],
    ['wrong archive', { archiveHash: 'a'.repeat(64) }],
    ['not reviewed', { reviewed: false }]
  ])('rejects %s without partial writes', async (_name, options) => {
    const db = await database();
    try {
      await expect(correct(db, options)).rejects.toThrow();
      expect(await state(db)).toEqual({
        account: { balance: '-100000.00' },
        transaction: { type: 'expense' },
        audit: { count: 0 }
      });
    } finally {
      await db.close();
    }
  });

  it('blocks reversed matches and another correction of the same transaction', async () => {
    const db = await database();
    try {
      await db.exec(`INSERT INTO public.shortcut_inbox_match_reversals(user_id,inbox_item_id,decision_id)
        VALUES ('${owner}','${inbox}','${decision}')`);
      await expect(correct(db)).rejects.toThrow();
      await db.exec('DELETE FROM public.shortcut_inbox_match_reversals');
      await db.exec(
        `INSERT INTO public.shortcut_payroll_type_corrections VALUES ('${owner}','${transaction}')`
      );
      await expect(correct(db)).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('prevents reversal and audit mutation after correction', async () => {
    const db = await database();
    try {
      await correct(db);
      await expect(
        db.exec(`INSERT INTO public.shortcut_inbox_match_reversals(user_id,inbox_item_id,decision_id)
        VALUES ('${owner}','${inbox}','${decision}')`)
      ).rejects.toThrow();
      await expect(
        db.exec('DELETE FROM public.shortcut_card_refund_corrections')
      ).rejects.toThrow();
      await expect(
        db.exec(`UPDATE public.transactions SET amount=1 WHERE id='${transaction}'`)
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('rejects another request for the corrected transaction', async () => {
    const db = await database();
    try {
      await correct(db);
      await expect(
        correct(db, { requestId: '77777777-7777-4777-8777-777777777777' })
      ).rejects.toThrow();
      expect(await state(db)).toEqual({
        account: { balance: '79982.00' },
        transaction: { type: 'income' },
        audit: { count: 1 }
      });
    } finally {
      await db.close();
    }
  });

  it('exposes the immutable audit only to its owner', async () => {
    const db = await database();
    try {
      await correct(db);
      await db.exec(`SET request.jwt.claim.sub = '${owner}'; SET ROLE authenticated;`);
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM public.shortcut_card_refund_corrections'
          )
        ).rows[0]
      ).toEqual({ count: 1 });
      await db.exec(`SET request.jwt.claim.sub = '${other}';`);
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM public.shortcut_card_refund_corrections'
          )
        ).rows[0]
      ).toEqual({ count: 0 });
      await expect(
        db.exec('UPDATE public.shortcut_card_refund_corrections SET amount=1')
      ).rejects.toThrow();
    } finally {
      await db.exec('RESET ROLE;');
      await db.close();
    }
  });

  it.each([
    [
      'the SMS amount',
      `UPDATE public.shortcut_inbox_items SET raw_text=replace(raw_text,'89,991.00','89,990.00')`
    ],
    [
      'the SMS card',
      `UPDATE public.shortcut_inbox_items SET raw_text=replace(raw_text,'*0265','*0181')`
    ],
    [
      'the SMS time',
      `UPDATE public.shortcut_inbox_items SET raw_text=replace(raw_text,'04:59','05:00')`
    ],
    ['the card suffix', `UPDATE public.accounts SET last_four='0181'`],
    ['the category type', `UPDATE public.categories SET type='expense'`],
    ['the transaction date', `UPDATE public.transactions SET date='2026-05-27'`]
  ])('rejects mismatched %s', async (_name, mutation) => {
    const db = await database();
    try {
      await db.exec(mutation);
      await expect(correct(db)).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});
