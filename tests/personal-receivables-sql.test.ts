import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../supabase/migrations/20260929000210_personal_receivables.sql', import.meta.url),
  'utf8'
);
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const outgoing = '33333333-3333-4333-8333-333333333333';
const incoming = '44444444-4444-4444-8444-444444444444';
const sale = '55555555-5555-4555-8555-555555555555';
const foreign = '66666666-6666-4666-8666-666666666666';

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.accounts(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      currency text NOT NULL, balance numeric(15,2) NOT NULL DEFAULT 0);
    CREATE TABLE public.transactions(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      account_id uuid NOT NULL, amount numeric(15,2) NOT NULL, date date NOT NULL,
      type text NOT NULL, deleted_at timestamptz, notes text,
      CONSTRAINT transactions_id_user_unique UNIQUE(id,user_id));
    GRANT SELECT ON public.accounts, public.transactions TO authenticated;
    INSERT INTO auth.users VALUES ('${owner}'), ('${other}');
    INSERT INTO public.accounts VALUES
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','${owner}','COP',1000000),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','${other}','COP',2000000);
    INSERT INTO public.transactions VALUES
      ('${outgoing}','${owner}','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',800000,'2026-05-05','expense',NULL,NULL),
      ('${incoming}','${owner}','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',100000,'2026-05-19','income',NULL,NULL),
      ('${sale}','${owner}','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',46000,'2026-07-15','income',NULL,NULL),
      ('${foreign}','${other}','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',100000,'2026-05-19','income',NULL,NULL);
  `);
  try {
    await db.exec(migration);
  } catch (error) {
    throw new Error(`migration failed: ${String(error)}`, { cause: error });
  }
  return db;
}

async function asOwner(db: PGlite, user = owner): Promise<void> {
  await db.exec(`SET request.jwt.claim.sub = '${user}'; SET ROLE authenticated;`);
}

async function confirm(
  db: PGlite,
  requestId: string,
  event: Record<string, unknown>
): Promise<{
  id: string;
  receivable_id: string;
  outstanding_minor: string;
  replayed: boolean;
}> {
  const { rows } = await db.query<{
    confirm_receivable_event: {
      id: string;
      receivable_id: string;
      outstanding_minor: string;
      replayed: boolean;
    };
  }>('SELECT public.confirm_receivable_event($1::uuid,true,$2::jsonb)', [
    requestId,
    JSON.stringify(event)
  ]);
  return rows[0].confirm_receivable_event;
}

const create = {
  action: 'create_receivable',
  borrower: 'Brother',
  label: 'May personal loan',
  currency: 'COP',
  money_scale: 0
};
const disbursement = (receivableId: string) => ({
  action: 'disbursement',
  receivable_id: receivableId,
  source_transaction_id: outgoing,
  occurred_on: '2026-05-05',
  amount_minor: '800000',
  evidence_reference: 'Owner-reviewed May 5 transfer'
});
const repayment = (receivableId: string) => ({
  action: 'repayment',
  receivable_id: receivableId,
  source_transaction_id: incoming,
  occurred_on: '2026-05-19',
  amount_minor: '100000',
  evidence_reference: 'Owner-confirmed principal repayment'
});

async function created(db: PGlite): Promise<string> {
  return (await confirm(db, 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', create)).receivable_id;
}

describe('personal receivables SQL ledger', () => {
  it('records the brother loan and only its confirmed principal repayment without moving bank balances', async () => {
    const db = await database();
    try {
      await asOwner(db);
      const id = await created(db);
      expect(
        (await confirm(db, 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', disbursement(id)))
          .outstanding_minor
      ).toBe('800000');
      expect(
        (await confirm(db, 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', repayment(id))).outstanding_minor
      ).toBe('700000');
      expect(
        (await db.query('SELECT balance FROM public.accounts WHERE user_id=$1', [owner])).rows[0]
      ).toMatchObject({ balance: '1000000.00' });
      expect(
        (
          await db.query(
            'SELECT count(*)::integer AS n FROM public.transactions WHERE user_id=$1',
            [owner]
          )
        ).rows[0]
      ).toMatchObject({ n: 3 });
      const events = (
        await db.query(
          'SELECT kind,source_transaction_id FROM public.personal_receivable_events WHERE receivable_id=$1 ORDER BY occurred_on',
          [id]
        )
      ).rows;
      expect(events).toMatchObject([
        { kind: 'disbursement', source_transaction_id: outgoing },
        { kind: 'repayment', source_transaction_id: incoming }
      ]);
    } finally {
      await db.close();
    }
  });

  it('leaves the separate July sale outside the loan and rejects duplicate source transactions', async () => {
    const db = await database();
    try {
      await asOwner(db);
      const id = await created(db);
      await confirm(db, 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', disbursement(id));
      await confirm(db, 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', repayment(id));
      expect(
        (
          await db.query(
            'SELECT count(*)::integer AS n FROM public.personal_receivable_events WHERE source_transaction_id=$1',
            [sale]
          )
        ).rows[0]
      ).toMatchObject({ n: 0 });
      expect(
        (
          await db.query('SELECT outstanding_minor FROM public.personal_receivables WHERE id=$1', [
            id
          ])
        ).rows[0]
      ).toMatchObject({ outstanding_minor: '700000' });
      await expect(
        confirm(db, 'aaaaaaaa-5555-4555-8555-aaaaaaaaaaaa', repayment(id))
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('replays identical requests but rejects a changed payload for the same request ID', async () => {
    const db = await database();
    try {
      await asOwner(db);
      const id = await created(db);
      const request = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
      const first = await confirm(db, request, disbursement(id));
      expect((await confirm(db, request, disbursement(id))).replayed).toBe(true);
      await expect(
        confirm(db, request, { ...disbursement(id), amount_minor: '700000' })
      ).rejects.toThrow();
      expect(
        (
          await db.query(
            'SELECT count(*)::integer AS n FROM public.personal_receivable_events WHERE receivable_id=$1',
            [id]
          )
        ).rows[0]
      ).toMatchObject({ n: 1 });
      expect(first.outstanding_minor).toBe('800000');
    } finally {
      await db.close();
    }
  });

  it('rejects wrong amount, date, direction, foreign owner, missing approval and overpayment', async () => {
    const db = await database();
    try {
      await asOwner(db);
      const id = await created(db);
      const base = disbursement(id);
      await expect(
        confirm(db, 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', { ...base, amount_minor: '799999' })
      ).rejects.toThrow();
      await expect(
        confirm(db, 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', { ...base, occurred_on: '2026-05-06' })
      ).rejects.toThrow();
      await expect(
        confirm(db, 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', {
          ...base,
          source_transaction_id: incoming,
          amount_minor: '100000',
          occurred_on: '2026-05-19'
        })
      ).rejects.toThrow();
      await expect(
        confirm(db, 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', {
          ...base,
          source_transaction_id: foreign,
          amount_minor: '100000',
          occurred_on: '2026-05-19'
        })
      ).rejects.toThrow();
      await expect(
        db.query('SELECT public.confirm_receivable_event($1::uuid,false,$2::jsonb)', [
          'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
          JSON.stringify(base)
        ])
      ).rejects.toThrow();
      await confirm(db, 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', base);
      await expect(
        confirm(db, 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', {
          ...repayment(id),
          amount_minor: '900000'
        })
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('keeps owner data private and prevents direct journal mutation', async () => {
    const db = await database();
    try {
      await asOwner(db);
      const id = await created(db);
      await expect(
        db.query('UPDATE public.personal_receivables SET outstanding_minor=$1 WHERE id=$2', [
          '1',
          id
        ])
      ).rejects.toThrow();
      await db.exec('RESET ROLE;');
      await asOwner(db, other);
      expect((await db.query('SELECT id FROM public.personal_receivables')).rows).toEqual([]);
      await expect(
        confirm(db, 'aaaaaaaa-9999-4999-8999-aaaaaaaaaaaa', disbursement(id))
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('protects linked principal sources but permits notes and privacy hard erasure', async () => {
    const db = await database();
    try {
      await asOwner(db);
      const id = await created(db);
      await confirm(db, 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', disbursement(id));
      await confirm(db, 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa', repayment(id));
      await db.exec('RESET ROLE;');
      await expect(
        db.query('UPDATE public.transactions SET amount=1 WHERE id=$1', [outgoing])
      ).rejects.toThrow();
      await expect(
        db.query('UPDATE public.transactions SET deleted_at=now() WHERE id=$1', [outgoing])
      ).rejects.toThrow();
      await db.query('UPDATE public.transactions SET notes=$1 WHERE id=$2', [
        'Reviewed loan',
        outgoing
      ]);
      expect(
        (await db.query('SELECT notes FROM public.transactions WHERE id=$1', [outgoing])).rows[0]
      ).toMatchObject({ notes: 'Reviewed loan' });
      await db.query('DELETE FROM public.transactions WHERE id=$1', [outgoing]);
      expect(
        (
          await db.query(
            'SELECT count(*)::integer AS n FROM public.personal_receivables WHERE id=$1',
            [id]
          )
        ).rows[0]
      ).toMatchObject({ n: 0 });
      expect(
        (
          await db.query(
            'SELECT count(*)::integer AS n FROM public.personal_receivable_requests WHERE user_id=$1',
            [owner]
          )
        ).rows[0]
      ).toMatchObject({ n: 0 });
      expect(
        (
          await db.query(
            'SELECT count(*)::integer AS n FROM public.personal_receivable_events WHERE user_id=$1',
            [owner]
          )
        ).rows[0]
      ).toMatchObject({ n: 0 });
    } finally {
      await db.close();
    }
  });
});
