import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(
  new URL(
    '../supabase/migrations/20261008000000_transaction_currency_foundation.sql',
    import.meta.url
  )
);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const copAccount = '33333333-3333-4333-8333-333333333333';
const copDestination = '44444444-4444-4444-8444-444444444444';
const usdAccount = '55555555-5555-4555-8555-555555555555';

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE TABLE public.accounts (
      id uuid PRIMARY KEY, user_id uuid NOT NULL, currency varchar(3),
      balance numeric(15,2) NOT NULL DEFAULT 0
    );
    CREATE TABLE public.transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
      account_id uuid NOT NULL REFERENCES public.accounts(id),
      transfer_to_account_id uuid REFERENCES public.accounts(id),
      amount numeric(15,2) NOT NULL CHECK (amount > 0), type text NOT NULL,
      description text, updated_at timestamptz DEFAULT now()
    );
    CREATE FUNCTION public.test_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
    CREATE TRIGGER transactions_updated_at BEFORE UPDATE ON public.transactions
      FOR EACH ROW EXECUTE FUNCTION public.test_set_updated_at();
    INSERT INTO public.accounts(id,user_id,currency) VALUES
      ('${copAccount}', '${owner}', 'COP'),
      ('${copDestination}', '${owner}', 'COP'),
      ('${usdAccount}', '${owner}', 'USD');
    INSERT INTO public.transactions(user_id, account_id, amount, type, description, updated_at)
      VALUES ('${owner}', '${copAccount}', 100, 'expense', 'Historical COP row',
        '2026-01-01T00:00:00Z');
    INSERT INTO public.transactions(user_id, account_id, amount, type, description)
      VALUES ('${owner}', '${usdAccount}', 50, 'expense', 'Unverified historical USD account row');
  `);
  await db.exec(migration);
  return db;
}

async function row(db: PGlite, description: string): Promise<Record<string, unknown>> {
  const result = await db.query<Record<string, unknown>>(
    'SELECT * FROM public.transactions WHERE description = $1',
    [description]
  );
  return result.rows[0];
}

describe('transaction currency foundation', () => {
  it('backfills COP postings without changing audited timestamps or unreviewed source amounts', async () => {
    const db = await database();
    try {
      expect(await row(db, 'Historical COP row')).toMatchObject({
        currency: 'COP',
        source_currency: null,
        source_amount: null,
        updated_at: new Date('2026-01-01T00:00:00Z')
      });
      expect((await row(db, 'Unverified historical USD account row')).currency).toBeNull();
      await db.query(
        `INSERT INTO public.transactions(user_id,account_id,amount,type,description)
         VALUES($1,$2,120,'expense','New COP row')`,
        [owner, copAccount]
      );
      expect(await row(db, 'New COP row')).toMatchObject({
        currency: 'COP',
        source_currency: 'COP',
        source_amount: '120.00'
      });
    } finally {
      await db.close();
    }
  });

  it('requires explicit USD and an account with the matching currency', async () => {
    const db = await database();
    try {
      await expect(
        db.query(
          `INSERT INTO public.transactions(user_id,account_id,amount,type,description)
           VALUES($1,$2,20,'expense','Implicit USD')`,
          [owner, usdAccount]
        )
      ).rejects.toThrow(/currency/i);
      await db.query(
        `INSERT INTO public.transactions(user_id,account_id,amount,type,description,currency)
         VALUES($1,$2,20,'expense','Explicit USD','USD')`,
        [owner, usdAccount]
      );
      expect(await row(db, 'Explicit USD')).toMatchObject({
        currency: 'USD',
        source_currency: 'USD',
        source_amount: '20.00'
      });
      await expect(
        db.query(
          `INSERT INTO public.transactions(user_id,account_id,amount,type,description,currency)
           VALUES($1,$2,20,'expense','Mismatched account','USD')`,
          [owner, copAccount]
        )
      ).rejects.toThrow(/currency/i);
    } finally {
      await db.close();
    }
  });

  it('blocks cross-currency transfers until both legs have an atomic writer', async () => {
    const db = await database();
    try {
      await expect(
        db.query(
          `INSERT INTO public.transactions(user_id,account_id,transfer_to_account_id,amount,type,description)
           VALUES($1,$2,$3,100,'transfer','Unsafe FX transfer')`,
          [owner, copAccount, usdAccount]
        )
      ).rejects.toThrow(/currency/i);
      await db.query(
        `INSERT INTO public.transactions(user_id,account_id,transfer_to_account_id,amount,type,description)
         VALUES($1,$2,$3,100,'transfer','COP transfer')`,
        [owner, copAccount, copDestination]
      );
      expect(await row(db, 'COP transfer')).toMatchObject({
        currency: 'COP',
        destination_amount: '100.00'
      });
    } finally {
      await db.close();
    }
  });

  it('requires a sourced rate when the original and posted currencies differ', async () => {
    const db = await database();
    try {
      await expect(
        db.query(
          `INSERT INTO public.transactions(user_id,account_id,amount,type,description,currency,source_currency,source_amount)
           VALUES($1,$2,330000,'expense','Missing rate','COP','USD',100)`,
          [owner, copAccount]
        )
      ).rejects.toThrow(/exchange rate/i);
      await db.query(
        `INSERT INTO public.transactions(user_id,account_id,amount,type,description,currency,source_currency,source_amount,
          fx_rate,fx_rate_source,fx_effective_date)
         VALUES($1,$2,330000,'expense','USD source','COP','USD',100,3300,'bank_posting','2026-10-08')`,
        [owner, copAccount]
      );
      expect(await row(db, 'USD source')).toMatchObject({
        currency: 'COP',
        source_currency: 'USD',
        source_amount: '100.00',
        fx_rate: '3300.0000000000'
      });
      await expect(
        db.query(
          `INSERT INTO public.transactions(user_id,account_id,amount,type,description,currency,source_currency,source_amount,
            fx_rate,fx_rate_source,fx_effective_date)
           VALUES($1,$2,330001,'expense','Inconsistent rate','COP','USD',100,3300,'bank_posting','2026-10-08')`,
          [owner, copAccount]
        )
      ).rejects.toThrow(/exchange rate/i);
    } finally {
      await db.close();
    }
  });

  it('rejects account ownership mismatches', async () => {
    const db = await database();
    try {
      await expect(
        db.query(
          `INSERT INTO public.transactions(user_id,account_id,amount,type,description)
           VALUES($1,$2,5,'expense','Wrong owner')`,
          [other, copAccount]
        )
      ).rejects.toThrow(/account/i);
    } finally {
      await db.close();
    }
  });

  it('rejects accounts without a supported currency and locks historical account currency', async () => {
    const db = await database();
    try {
      const unknownAccount = '66666666-6666-4666-8666-666666666666';
      await db.query('INSERT INTO public.accounts(id,user_id,currency) VALUES($1,$2,null)', [
        unknownAccount,
        owner
      ]);
      await expect(
        db.query(
          `INSERT INTO public.transactions(user_id,account_id,amount,type,description)
           VALUES($1,$2,5,'expense','Unknown account currency')`,
          [owner, unknownAccount]
        )
      ).rejects.toThrow(/currency/i);
      await expect(
        db.query('UPDATE public.accounts SET currency = $1 WHERE id = $2', ['USD', copAccount])
      ).rejects.toThrow(/currency/i);
    } finally {
      await db.close();
    }
  });

  it('does not reinterpret a nonzero account balance as another currency', async () => {
    const db = await database();
    try {
      const fundedAccount = '77777777-7777-4777-8777-777777777777';
      await db.query(
        'INSERT INTO public.accounts(id,user_id,currency,balance) VALUES($1,$2,$3,10)',
        [fundedAccount, owner, 'COP']
      );
      await expect(
        db.query('UPDATE public.accounts SET currency = $1 WHERE id = $2', ['USD', fundedAccount])
      ).rejects.toThrow(/currency/i);
    } finally {
      await db.close();
    }
  });

  it('preserves unknown historical source data during a COP amount correction', async () => {
    const db = await database();
    try {
      await db.query(
        `UPDATE public.transactions SET amount = 125
         WHERE description = 'Historical COP row'`
      );
      expect(await row(db, 'Historical COP row')).toMatchObject({
        amount: '125.00',
        currency: 'COP',
        source_currency: null,
        source_amount: null
      });
    } finally {
      await db.close();
    }
  });

  it('keeps a new same-currency source amount aligned after an amount correction', async () => {
    const db = await database();
    try {
      await db.query(
        `INSERT INTO public.transactions(user_id,account_id,amount,type,description)
         VALUES($1,$2,120,'expense','Corrected COP row')`,
        [owner, copAccount]
      );
      await db.query(
        `UPDATE public.transactions SET amount = 125
         WHERE description = 'Corrected COP row'`
      );
      expect(await row(db, 'Corrected COP row')).toMatchObject({
        amount: '125.00',
        source_currency: 'COP',
        source_amount: '125.00'
      });
    } finally {
      await db.close();
    }
  });
});
