import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
it('enables a separate currency balance once, with owner isolation and immutable grouping', async () => {
  const db = new PGlite();
  const owner = '00000000-0000-4000-8000-000000000001',
    other = '00000000-0000-4000-8000-000000000002',
    id = '10000000-0000-4000-8000-000000000001';
  try {
    await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 CREATE FUNCTION has_accepted_required_terms() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
 CREATE TABLE accounts(id uuid primary key default gen_random_uuid(),user_id uuid,name text,type text,institution text,last_four text,bank_account_last_four text,identifiers jsonb,currency text,balance numeric default 0,is_active boolean default true,is_default boolean default false,color text,icon text,deleted_at timestamptz);
 INSERT INTO accounts(id,user_id,name,type,institution,last_four,currency,balance) VALUES('${id}','${owner}','Card','credit_card','Bank','8887','COP',123);
 GRANT SELECT,INSERT,UPDATE ON accounts TO authenticated;`);
    await db.exec(
      readFileSync('supabase/migrations/20261019000030_account_currency_ledgers.sql', 'utf8')
    );
    await db.exec(
      readFileSync('supabase/migrations/20261019000090_account_currency_group_metadata.sql', 'utf8')
    );
    await db.exec(
      `UPDATE accounts SET bank_account_last_four='1234' WHERE id='${id}'; CREATE UNIQUE INDEX accounts_owner_bank_account_suffix_idx ON accounts(user_id,lower(institution),bank_account_last_four) WHERE bank_account_last_four IS NOT NULL AND deleted_at IS NULL;`
    );
    const suffixMigration = 'supabase/migrations/20261020000050_currency_ledger_identifiers.sql';
    if (existsSync(suffixMigration)) await db.exec(readFileSync(suffixMigration, 'utf8'));
    await db.exec(`SET request.jwt.claim.sub='${owner}'; SET ROLE authenticated;`);
    const enable = () =>
      db.query<{
        result: { id: string; parent_account_id: string; currency: string; balance: number };
      }>(`SELECT enable_account_currency($1,'USD') result`, [id]);
    const first = (await enable()).rows[0].result;
    expect(first).toMatchObject({ parent_account_id: id, currency: 'USD', balance: 0 });
    expect((await enable()).rows[0].result.id).toBe(first.id);
    await expect(db.query(`SELECT enable_account_currency($1,'EUR')`, [id])).rejects.toThrow(
      /currency/i
    );
    await expect(db.exec(`UPDATE accounts SET type='cash' WHERE id='${id}'`)).rejects.toThrow(
      /group/i
    );
    await db.exec(`UPDATE accounts SET name='Renamed card' WHERE id='${id}'`);
    expect((await db.query(`SELECT name FROM accounts WHERE id='${first.id}'`)).rows).toEqual([
      { name: 'Renamed card · USD' }
    ]);
    await db.exec(`SET request.jwt.claim.sub='${other}';`);
    await expect(enable()).rejects.toThrow(/not found/i);
    await db.exec(`SET request.jwt.claim.sub='${owner}';`);
    await expect(
      db.exec(`UPDATE accounts SET parent_account_id=null WHERE id='${first.id}'`)
    ).rejects.toThrow(/group/i);
    await expect(db.exec(`UPDATE accounts SET deleted_at=now() WHERE id='${id}'`)).rejects.toThrow(
      /currenc/i
    );
    expect((await db.query(`SELECT balance FROM accounts WHERE id='${id}'`)).rows).toEqual([
      { balance: '123' }
    ]);
  } finally {
    await db.close();
  }
}, 15000);
