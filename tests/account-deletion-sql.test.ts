import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const path = new URL(
  '../supabase/migrations/20260929000160_guard_account_delete.sql',
  import.meta.url
);
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const source = '33333333-3333-4333-8333-333333333333';
const destination = '44444444-4444-4444-8444-444444444444';
const empty = '55555555-5555-4555-8555-555555555555';
const foreign = '66666666-6666-4666-8666-666666666666';

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.accounts(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      is_default boolean NOT NULL DEFAULT false, deleted_at timestamptz,
      balance numeric(15,2) NOT NULL DEFAULT 0);
    CREATE TABLE public.transactions(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      account_id uuid NOT NULL REFERENCES public.accounts(id),
      transfer_to_account_id uuid REFERENCES public.accounts(id),
      deleted_at timestamptz);
    INSERT INTO public.accounts(id,user_id,is_default,balance) VALUES
      ('${source}','${owner}',false,100),
      ('${destination}','${owner}',false,200),
      ('${empty}','${owner}',false,300),
      ('${foreign}','${other}',false,400);
    INSERT INTO public.transactions VALUES
      ('77777777-7777-4777-8777-777777777777','${owner}','${source}','${destination}',NULL);
  `);
  if (existsSync(path)) await db.exec(readFileSync(path, 'utf8'));
  return db;
}

async function remove(db: PGlite, user: string, id: string): Promise<boolean> {
  await db.exec(`SET request.jwt.claim.sub = '${user}'; SET ROLE authenticated;`);
  try {
    const result = await db.query<{ soft_delete_empty_account: boolean }>(
      'SELECT public.soft_delete_empty_account($1::uuid)',
      [id]
    );
    return result.rows[0].soft_delete_empty_account;
  } finally {
    await db.exec('RESET ROLE;');
  }
}

describe('atomic account deletion', () => {
  it('blocks both source and transfer destination while their transactions are active', async () => {
    const db = await database();
    try {
      await expect(remove(db, owner, source)).rejects.toThrow(/active transaction/i);
      await expect(remove(db, owner, destination)).rejects.toThrow(/active transaction/i);
      expect(
        (await db.query('SELECT id,deleted_at,balance FROM public.accounts ORDER BY id')).rows
      ).toEqual([
        { id: source, deleted_at: null, balance: '100.00' },
        { id: destination, deleted_at: null, balance: '200.00' },
        { id: empty, deleted_at: null, balance: '300.00' },
        { id: foreign, deleted_at: null, balance: '400.00' }
      ]);
    } finally {
      await db.close();
    }
  });

  it('soft-deletes an empty owned account once and never changes balances', async () => {
    const db = await database();
    try {
      expect(await remove(db, owner, empty)).toBe(true);
      expect(await remove(db, owner, empty)).toBe(false);
      expect(
        (
          await db.query(`SELECT deleted_at IS NOT NULL AS deleted,balance
        FROM public.accounts WHERE id='${empty}'`)
        ).rows
      ).toEqual([{ deleted: true, balance: '300.00' }]);
    } finally {
      await db.close();
    }
  });

  it('prevents a new active transaction from referencing a deleted account', async () => {
    const db = await database();
    try {
      expect(await remove(db, owner, empty)).toBe(true);
      await expect(
        db.exec(`INSERT INTO public.transactions VALUES
        ('88888888-8888-4888-8888-888888888888','${owner}','${empty}',NULL,NULL)`)
      ).rejects.toThrow(/active account/i);
      await expect(
        db.exec(`INSERT INTO public.transactions VALUES
        ('99999999-9999-4999-8999-999999999999','${owner}','${source}','${empty}',NULL)`)
      ).rejects.toThrow(/active account/i);
    } finally {
      await db.close();
    }
  });

  it('blocks direct soft deletion of an account referenced by an active transfer', async () => {
    const db = await database();
    try {
      await expect(
        db.exec(`UPDATE public.accounts SET deleted_at=now()
        WHERE id='${destination}'`)
      ).rejects.toThrow(/active transaction/i);
      expect(
        (
          await db.query(`SELECT deleted_at FROM public.accounts
        WHERE id='${destination}'`)
        ).rows
      ).toEqual([{ deleted_at: null }]);
    } finally {
      await db.close();
    }
  });

  it('rejects a foreign account and a default account', async () => {
    const db = await database();
    try {
      await expect(remove(db, owner, foreign)).rejects.toThrow(/not found/i);
      await db.exec(`UPDATE public.accounts SET is_default=true WHERE id='${empty}'`);
      await expect(remove(db, owner, empty)).rejects.toThrow(/default account/i);
    } finally {
      await db.close();
    }
  });

  it('does not let anonymous callers execute the function', async () => {
    const db = await database();
    try {
      await db.exec('SET ROLE anon;');
      await expect(db.query(`SELECT public.soft_delete_empty_account('${empty}')`)).rejects.toThrow(
        /permission denied/i
      );
    } finally {
      await db.close();
    }
  });
});
