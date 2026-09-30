import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../supabase/migrations/20260929000220_relief_fund_journal.sql', import.meta.url),
  'utf8'
);
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const income = '33333333-3333-4333-8333-333333333333';
const expense = '44444444-4444-4444-8444-444444444444';
const foreign = '55555555-5555-4555-8555-555555555555';
const request = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.transactions(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      type text NOT NULL, amount numeric(15,2) NOT NULL, deleted_at timestamptz);
    CREATE TABLE public.accounts(id uuid PRIMARY KEY, balance numeric(15,2));
    INSERT INTO auth.users VALUES ('${owner}'),('${other}');
    INSERT INTO public.transactions VALUES
      ('${income}','${owner}','income',250000,NULL),
      ('${expense}','${owner}','expense',90500,NULL),
      ('${foreign}','${other}','income',100000,NULL);
    INSERT INTO public.accounts VALUES ('66666666-6666-4666-8666-666666666666',1000000);
  `);
  await db.exec(migration);
  return db;
}

async function confirm(db: PGlite, n: number, event: Record<string, unknown>, user = owner) {
  await db.exec(`SET request.jwt.claim.sub = '${user}'; SET ROLE authenticated;`);
  try {
    const result = await db.query<{ confirm_relief_fund_event: Record<string, unknown> }>(
      'SELECT public.confirm_relief_fund_event($1::uuid,true,$2::jsonb)',
      [request(n), JSON.stringify(event)]
    );
    return result.rows[0].confirm_relief_fund_event;
  } finally {
    await db.exec('RESET ROLE');
  }
}

const createFund = {
  action: 'create_fund',
  title: 'August 2026 emergency relief',
  purpose: 'Community purchases after the earthquake',
  currency: 'COP'
};
const receipt = (fundId: string, transactionId: string | null = income) => ({
  action: 'add_entry',
  fund_id: fundId,
  kind: 'receipt',
  occurred_on: '2026-08-14',
  amount_minor: '25000000',
  description: 'Donation for emergency purchases',
  source_kind: transactionId ? 'ledger_transaction' : 'bank_notice',
  source_reference: 'Reviewed donation notification',
  transaction_id: transactionId
});

describe('owner-reviewed relief fund journal', () => {
  it('records exact donations and known outlays without changing bank balances or ledger rows', async () => {
    const db = await database();
    try {
      const fund = await confirm(db, 1, createFund);
      const fundId = fund.fund_id as string;
      await confirm(db, 2, receipt(fundId));
      await confirm(db, 3, {
        ...receipt(fundId, null),
        kind: 'outlay',
        amount_minor: '9050000',
        occurred_on: '2026-08-15',
        source_kind: 'cash',
        source_reference: 'Reviewed cash receipt',
        description: 'Purchased relief supplies'
      });
      const entries = await db.query<{ kind: string; amount_minor: string }>(
        `SELECT kind,amount_minor FROM public.relief_fund_entries WHERE fund_id='${fundId}' ORDER BY created_at,id`
      );
      expect(entries.rows).toEqual([
        { kind: 'receipt', amount_minor: '25000000' },
        { kind: 'outlay', amount_minor: '9050000' }
      ]);
      expect((await db.query('SELECT balance FROM public.accounts')).rows).toEqual([
        { balance: '1000000.00' }
      ]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.transactions')).rows
      ).toEqual([{ count: 3 }]);
    } finally {
      await db.close();
    }
  });

  it('records unquantified cash spending without inventing an amount', async () => {
    const db = await database();
    try {
      const fundId = (await confirm(db, 1, createFund)).fund_id as string;
      await confirm(db, 2, {
        action: 'add_entry',
        fund_id: fundId,
        kind: 'unknown_spend',
        occurred_on: null,
        amount_minor: null,
        description: 'Cash purchases; exact amount unknown',
        source_kind: 'manual_recollection',
        source_reference: 'Owner recollection',
        transaction_id: null
      });
      expect(
        (
          await db.query(
            `SELECT kind,occurred_on,amount_minor FROM public.relief_fund_entries WHERE fund_id='${fundId}'`
          )
        ).rows
      ).toEqual([{ kind: 'unknown_spend', occurred_on: null, amount_minor: null }]);
      await expect(
        confirm(db, 3, {
          ...receipt(fundId, null),
          kind: 'outlay',
          amount_minor: null
        })
      ).rejects.toThrow(/amount/i);
    } finally {
      await db.close();
    }
  });

  it('replays the same request but rejects a changed payload or duplicate transaction link', async () => {
    const db = await database();
    try {
      const fundId = (await confirm(db, 1, createFund)).fund_id as string;
      const event = receipt(fundId);
      const first = await confirm(db, 2, event);
      expect(await confirm(db, 2, event)).toMatchObject({ ...first, replayed: true });
      await expect(confirm(db, 2, { ...event, amount_minor: '100' })).rejects.toThrow(/request/i);
      await expect(confirm(db, 3, event)).rejects.toThrow(/transaction/i);
    } finally {
      await db.close();
    }
  });

  it('rejects cross-owner, wrong-direction and unreviewed transaction links', async () => {
    const db = await database();
    try {
      const fundId = (await confirm(db, 1, createFund)).fund_id as string;
      await expect(confirm(db, 2, receipt(fundId, foreign))).rejects.toThrow(/transaction/i);
      await expect(confirm(db, 3, receipt(fundId, expense))).rejects.toThrow(/transaction/i);
      await expect(confirm(db, 4, receipt(fundId), other)).rejects.toThrow(/fund/i);
      await expect(
        confirm(db, 5, { ...receipt(fundId), amount_minor: '25000001' })
      ).rejects.toThrow(/transaction/i);
    } finally {
      await db.close();
    }
  });

  it('rejects malformed fund and transaction IDs before casting', async () => {
    const db = await database();
    try {
      const fundId = (await confirm(db, 1, createFund)).fund_id as string;
      await expect(confirm(db, 2, receipt('------------------------------------'))).rejects.toThrow(
        /Invalid fund ID/
      );
      await expect(
        confirm(db, 3, receipt(fundId, '------------------------------------'))
      ).rejects.toThrow(/Reviewed transaction link required/);
    } finally {
      await db.close();
    }
  });

  it('prevents authenticated direct mutation of journal entries', async () => {
    const db = await database();
    try {
      const fundId = (await confirm(db, 1, createFund)).fund_id as string;
      await confirm(db, 2, receipt(fundId));
      await db.exec(`SET request.jwt.claim.sub = '${owner}'; SET ROLE authenticated;`);
      await expect(
        db.query(`UPDATE public.relief_fund_entries SET amount_minor='1' WHERE fund_id='${fundId}'`)
      ).rejects.toThrow();
      await expect(
        db.query(`DELETE FROM public.relief_fund_entries WHERE fund_id='${fundId}'`)
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('keeps source and transaction references immutable even for privileged updates', async () => {
    const db = await database();
    try {
      const fundId = (await confirm(db, 1, createFund)).fund_id as string;
      await confirm(db, 2, receipt(fundId));
      await expect(
        db.query(
          `UPDATE public.relief_fund_entries SET source_reference='rewritten' WHERE fund_id='${fundId}'`
        )
      ).rejects.toThrow(/immutable/i);
      expect(
        (
          await db.query(
            `SELECT source_reference FROM public.relief_fund_entries WHERE fund_id='${fundId}'`
          )
        ).rows
      ).toEqual([{ source_reference: 'Reviewed donation notification' }]);
    } finally {
      await db.close();
    }
  });
});
