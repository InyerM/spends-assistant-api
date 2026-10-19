import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
it('suggests same-contact history and changes only confirmed unchanged categories atomically', async () => {
  const db = new PGlite();
  const owner = '00000000-0000-4000-8000-000000000001',
    other = '00000000-0000-4000-8000-000000000002',
    source = '10000000-0000-4000-8000-000000000001',
    target = '10000000-0000-4000-8000-000000000002',
    category = '20000000-0000-4000-8000-000000000001';
  try {
    await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid primary key); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 CREATE FUNCTION has_accepted_required_terms() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
 CREATE TABLE categories(id uuid primary key,user_id uuid,name text,slug text,type text,is_active boolean,deleted_at timestamptz);
 CREATE TABLE transactions(id uuid primary key,user_id uuid,category_id uuid,type text,date date,description text,amount numeric,currency text,deleted_at timestamptz);
 CREATE TABLE counterparties(id uuid primary key,user_id uuid,custom_name text,display_name text);
 CREATE TABLE transaction_counterparties(transaction_id uuid,user_id uuid,contact_id uuid);
 INSERT INTO auth.users VALUES('${owner}'),('${other}');
 INSERT INTO categories VALUES('${category}','${owner}','Lunch','lunch','expense',true,null);
 INSERT INTO transactions VALUES('${source}','${owner}','${category}','expense','2026-10-19','Recent',100,'COP',null),('${target}','${owner}',null,'expense','2026-10-01','Older',100,'COP',null);
 INSERT INTO counterparties VALUES('${source}','${owner}',null,'Contact'); INSERT INTO transaction_counterparties VALUES('${source}','${owner}','${source}'),('${target}','${owner}','${source}');`);
    await db.exec(
      readFileSync('supabase/migrations/20261019000010_counterparty_category_followup.sql', 'utf8')
    );
    await db.exec(
      readFileSync('supabase/migrations/20261019000050_category_suggestion_queue.sql', 'utf8')
    );
    await db.exec(`SET request.jwt.claim.sub='${owner}'; SET ROLE authenticated;`);
    expect(
      (
        await db.query<{ result: Array<{ transaction_id: string; count: number }> }>(
          `SELECT list_category_suggestions(null) result`
        )
      ).rows[0].result
    ).toMatchObject([{ transaction_id: source, count: 1 }]);
    const suggestion = await db.query<{ result: { rows: Array<{ id: string }> } }>(
      `SELECT counterparty_category_followup('${source}') result`
    );
    expect(suggestion.rows[0].result.rows.map((r) => r.id)).toEqual([target]);
    const apply = () =>
      db.query(`SELECT apply_counterparty_category_followup($1,$2,$3)`, [
        source,
        category,
        JSON.stringify([{ id: target, category_id: null }])
      ]);
    await db.exec(
      `RESET ROLE; UPDATE transactions SET category_id='${category}' WHERE id='${target}'; SET ROLE authenticated;`
    );
    await expect(apply()).rejects.toThrow(/changed/i);
    await db.exec(
      `RESET ROLE; UPDATE transactions SET category_id=null WHERE id='${target}'; SET ROLE authenticated; SET request.jwt.claim.sub='${other}';`
    );
    await expect(apply()).rejects.toThrow(/not found/i);
    await db.exec(`SET request.jwt.claim.sub='${owner}';`);
    await apply();
    await db.exec('RESET ROLE;');
    expect(
      (await db.query(`SELECT category_id FROM transactions WHERE id='${target}'`)).rows
    ).toEqual([{ category_id: category }]);
    expect((await db.query('SELECT amount FROM transactions')).rows).toEqual([
      { amount: '100' },
      { amount: '100' }
    ]);
  } finally {
    await db.close();
  }
}, 15000);
