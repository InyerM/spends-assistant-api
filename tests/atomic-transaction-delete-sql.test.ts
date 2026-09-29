import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL(
  '../supabase/migrations/20260929000140_atomic_transaction_delete.sql',
  import.meta.url
);
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const source = '33333333-3333-4333-8333-333333333333';
const destination = '44444444-4444-4444-8444-444444444444';
const otherAccount = '55555555-5555-4555-8555-555555555555';
const expense = '66666666-6666-4666-8666-666666666661';
const transfer = '66666666-6666-4666-8666-666666666662';
const foreign = '66666666-6666-4666-8666-666666666663';

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.accounts(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      balance numeric(15,2));
    CREATE TABLE public.transactions(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      type text NOT NULL, amount numeric(15,2) NOT NULL,
      account_id uuid NOT NULL, transfer_to_account_id uuid,
      deleted_at timestamptz);
    CREATE TABLE public.document_observation_decisions(
      user_id uuid NOT NULL, transaction_id uuid);
    CREATE TABLE public.shortcut_inbox_match_decisions(
      user_id uuid NOT NULL, transaction_id uuid);
    INSERT INTO public.accounts VALUES
      ('${source}','${owner}',8800),
      ('${destination}','${owner}',4200),
      ('${otherAccount}','${other}',4900);
    INSERT INTO public.transactions VALUES
      ('${expense}','${owner}','expense',1200,'${source}',NULL,NULL),
      ('${transfer}','${owner}','transfer',1200,'${source}','${destination}',NULL),
      ('${foreign}','${other}','expense',100,'${otherAccount}',NULL,NULL);
  `);
  if (existsSync(migrationPath)) await db.exec(readFileSync(migrationPath, 'utf8'));
  return db;
}

async function remove(db: PGlite, user: string, ids: string[]): Promise<number> {
  await db.exec(`SET request.jwt.claim.sub = '${user}'; SET ROLE authenticated;`);
  try {
    const result = await db.query<{ soft_delete_transactions: number }>(
      'SELECT public.soft_delete_transactions($1::uuid[])',
      [ids]
    );
    return result.rows[0].soft_delete_transactions;
  } finally {
    await db.exec('RESET ROLE;');
  }
}

describe('atomic transaction deletion', () => {
  it('reverses expense and transfer balances once, including a repeated request', async () => {
    const db = await database();
    try {
      expect(await remove(db, owner, [expense, transfer])).toBe(2);
      expect(await remove(db, owner, [expense, transfer])).toBe(0);
      expect((await db.query('SELECT id,balance FROM public.accounts ORDER BY id')).rows).toEqual([
        { id: source, balance: '11200.00' },
        { id: destination, balance: '3000.00' },
        { id: otherAccount, balance: '4900.00' }
      ]);
      expect(
        (
          await db.query(`SELECT count(*)::int AS count FROM public.transactions
        WHERE user_id='${owner}' AND deleted_at IS NULL`)
        ).rows
      ).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });

  it('ignores transactions owned by another user and rejects anonymous execution', async () => {
    const db = await database();
    try {
      expect(await remove(db, owner, [foreign])).toBe(0);
      expect(
        (await db.query(`SELECT deleted_at FROM public.transactions WHERE id='${foreign}'`)).rows
      ).toEqual([{ deleted_at: null }]);
      await db.exec('SET ROLE anon;');
      await expect(
        db.query(`SELECT public.soft_delete_transactions(ARRAY['${expense}']::uuid[])`)
      ).rejects.toThrow(/permission denied/);
      await db.exec('RESET ROLE;');
    } finally {
      await db.close();
    }
  });

  it('refuses to delete a reviewed link without changing its account balance', async () => {
    const db = await database();
    try {
      await db.exec(
        `INSERT INTO public.document_observation_decisions VALUES ('${owner}','${expense}');`
      );
      await expect(remove(db, owner, [expense])).rejects.toThrow(/reviewed/i);
      await db.exec(`DELETE FROM public.document_observation_decisions;
        INSERT INTO public.shortcut_inbox_match_decisions VALUES ('${owner}','${expense}');`);
      await expect(remove(db, owner, [expense])).rejects.toThrow(/reviewed/i);
      expect(
        (await db.query(`SELECT balance FROM public.accounts WHERE id='${source}'`)).rows
      ).toEqual([{ balance: '8800.00' }]);
      expect(
        (await db.query(`SELECT deleted_at FROM public.transactions WHERE id='${expense}'`)).rows
      ).toEqual([{ deleted_at: null }]);
    } finally {
      await db.close();
    }
  });

  it('rolls back the soft delete when balance reversal fails', async () => {
    const db = await database();
    try {
      await db.exec(`CREATE FUNCTION public.reject_balance() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Synthetic balance failure'; END $$;
        CREATE TRIGGER reject_balance BEFORE UPDATE ON public.accounts
          FOR EACH ROW EXECUTE FUNCTION public.reject_balance();`);
      await expect(remove(db, owner, [expense])).rejects.toThrow(/Synthetic balance failure/);
      expect(
        (await db.query(`SELECT deleted_at FROM public.transactions WHERE id='${expense}'`)).rows
      ).toEqual([{ deleted_at: null }]);
    } finally {
      await db.close();
    }
  });
});
