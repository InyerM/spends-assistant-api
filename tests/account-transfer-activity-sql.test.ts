import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('separates earned income and expenses from both transfer legs without mixing posting currencies', async () => {
  const db = new PGlite();
  const owner = '00000000-0000-4000-8000-000000000001',
    account = '10000000-0000-4000-8000-000000000001',
    funding = '10000000-0000-4000-8000-000000000002';
  try {
    await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role; CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${owner}'::uuid $$;
      CREATE FUNCTION has_accepted_required_terms() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE TABLE accounts(id uuid,user_id uuid,deleted_at timestamptz,currency text);
      CREATE TABLE categories(id uuid,user_id uuid,name text,translations jsonb);
      CREATE TABLE transactions(id uuid DEFAULT gen_random_uuid(),user_id uuid,account_id uuid,transfer_to_account_id uuid,type text,currency text,source_currency text,amount numeric,destination_amount numeric,date date,category_id uuid,deleted_at timestamptz);
      INSERT INTO accounts VALUES('${account}','${owner}',null,'USD'),('${funding}','${owner}',null,'COP');
      INSERT INTO transactions(user_id,account_id,transfer_to_account_id,type,currency,source_currency,amount,destination_amount,date) VALUES
       ('${owner}','${funding}','${account}','transfer','COP','USD',20000,5,current_date),
       ('${owner}','${account}','${funding}','transfer','USD','COP',2,8000,current_date),
       ('${owner}','${account}',null,'income','USD','USD',3,null,current_date),
       ('${owner}','${account}',null,'expense','USD','USD',1,null,current_date);`);
    await db.exec(
      readFileSync('supabase/migrations/20261020000091_account_transfer_activity.sql', 'utf8')
    );
    const result = (
      await db.query<{
        data: {
          income: number;
          expenses: number;
          transfers_in: number;
          transfers_out: number;
          count: number;
          months: Array<{ transfers_in: number; transfers_out: number }>;
        };
      }>('SELECT account_activity($1) AS data', [account])
    ).rows[0].data;
    expect(result).toMatchObject({
      income: 3,
      expenses: 1,
      transfers_in: 5,
      transfers_out: 2,
      count: 4
    });
    expect(result.months.at(-1)).toMatchObject({ transfers_in: 5, transfers_out: 2 });
    const cop = (
      await db.query<{ data: { transfers_in: number; transfers_out: number } }>(
        'SELECT account_activity($1) AS data',
        [funding]
      )
    ).rows[0].data;
    expect(cop).toMatchObject({ transfers_in: 8000, transfers_out: 20000 });
    await expect(
      db.query('SELECT account_activity($1)', ['10000000-0000-4000-8000-000000000099'])
    ).rejects.toThrow(/Account not found/);
  } finally {
    await db.close();
  }
});
