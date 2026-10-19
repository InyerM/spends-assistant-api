import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
const owner = '00000000-0000-4000-8000-000000000001',
  other = '00000000-0000-4000-8000-000000000002';
const account = '10000000-0000-4000-8000-000000000001',
  doc = '20000000-0000-4000-8000-000000000001',
  row = '30000000-0000-4000-8000-000000000001',
  key = '40000000-0000-4000-8000-000000000001';
it('creates and reconciles one explicitly reviewed statement movement atomically and isolates owners', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 CREATE FUNCTION has_accepted_required_terms() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
 CREATE TABLE auth.users(id uuid primary key);
 CREATE TABLE accounts(id uuid primary key,user_id uuid,currency text,deleted_at timestamptz,is_active boolean,balance numeric);
 CREATE TABLE categories(id uuid primary key,user_id uuid,type text,is_active boolean,deleted_at timestamptz);
 CREATE TABLE documents(id uuid primary key,user_id uuid,document_type text,status text,archived_at timestamptz,file_name text);
 CREATE TABLE document_observations(id uuid primary key,user_id uuid,document_id uuid,amount numeric,currency text,occurred_at_text text,status text,description text,source_excerpt text);
 CREATE TABLE transactions(id uuid primary key,user_id uuid,account_id uuid,transfer_to_account_id uuid,currency text,amount numeric,date date,time time,type text,deleted_at timestamptz,description text,category_id uuid,parsed_data jsonb,source text,raw_text text);
 CREATE TABLE usage_tracking(user_id uuid,month text,transactions_count int default 0,updated_at timestamptz,primary key(user_id,month));
 CREATE TABLE subscriptions(user_id uuid,plan text,status text); CREATE TABLE app_settings(key text,value jsonb);
 INSERT INTO auth.users VALUES('${owner}'),('${other}');
 INSERT INTO accounts VALUES('${account}','${owner}','USD',null,true,500);
 INSERT INTO documents VALUES('${doc}','${owner}','statement','extracted',null,'Synthetic.pdf');
 INSERT INTO document_observations VALUES('${row}','${owner}','${doc}',-100,'USD','2026-09-11','pending','Lunch','11/09 Lunch 100');`);
    await db.exec(
      readFileSync('supabase/migrations/20261009000050_statement_reconciliation.sql', 'utf8')
    );
    await db.exec(
      readFileSync('supabase/migrations/20261019000000_statement_transaction_creation.sql', 'utf8')
    );
    await db.exec(`SET request.jwt.claim.sub='${owner}'; SET ROLE authenticated;`);
    await db.query(
      `SELECT set_statement_reconciliation_scope('${doc}','${account}','2026-09-01','2026-09-30')`
    );
    const call = () =>
      db.query<{ result: { transaction_id: string } }>(
        `SELECT create_statement_transaction($1,$2,$3,$4,$5) result`,
        [key, doc, row, null, 'Reviewed lunch']
      );
    const first = await call();
    expect((await call()).rows).toEqual(first.rows);
    expect((await db.query('SELECT valid FROM statement_reconciliation_proofs')).rows).toEqual([
      { valid: true }
    ]);
    await db.exec('RESET ROLE;');
    expect((await db.query('SELECT balance FROM accounts')).rows).toEqual([{ balance: '400' }]);
    expect((await db.query('SELECT transactions_count FROM usage_tracking')).rows).toEqual([
      { transactions_count: 1 }
    ]);
    expect(
      (await db.query('SELECT source,currency,parsed_data FROM transactions')).rows[0]
    ).toMatchObject({
      source: 'statement',
      currency: 'USD',
      parsed_data: { document_id: doc, observation_id: row, time_unknown: true }
    });
    await db.exec(`SET request.jwt.claim.sub='${other}'; SET ROLE authenticated;`);
    await expect(call()).rejects.toThrow(/not found/i);
    await db.exec(`RESET ROLE; SET request.jwt.claim.sub='${owner}';`);
    await expect(
      db.exec(
        `INSERT INTO transactions(id,user_id,parsed_data,source) VALUES(gen_random_uuid(),'${owner}','{"document_id":"${doc}"}','statement')`
      )
    ).rejects.toThrow(/reviewed statement/i);
    await db.exec(`INSERT INTO document_observations VALUES('30000000-0000-4000-8000-000000000002','${owner}','${doc}',-50,'USD','2026-09-12','pending','Fee','12/09 Fee 50');
      CREATE FUNCTION fail_statement_balance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic balance failure'; END $$;
      CREATE TRIGGER fail_statement_balance BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION fail_statement_balance(); SET ROLE authenticated;`);
    await expect(
      db.query(
        `SELECT create_statement_transaction('40000000-0000-4000-8000-000000000002','${doc}','30000000-0000-4000-8000-000000000002',null,'Fee')`
      )
    ).rejects.toThrow(/Synthetic balance failure/);
    await db.exec('RESET ROLE; DROP TRIGGER fail_statement_balance ON accounts;');
    expect((await db.query('SELECT count(*)::int n FROM transactions')).rows).toEqual([{ n: 1 }]);
    expect(
      (await db.query('SELECT count(*)::int n FROM statement_transaction_requests')).rows
    ).toEqual([{ n: 1 }]);
    expect((await db.query('SELECT transactions_count FROM usage_tracking')).rows).toEqual([
      { transactions_count: 1 }
    ]);
    await db.exec(`INSERT INTO accounts VALUES('10000000-0000-4000-8000-000000000002','${owner}','USD',null,true,200);
      UPDATE document_observations SET amount=50 WHERE id='30000000-0000-4000-8000-000000000002'; SET ROLE authenticated;`);
    await db.query(
      `SELECT create_statement_transaction('40000000-0000-4000-8000-000000000003','${doc}','30000000-0000-4000-8000-000000000002',null,'Card payment','10000000-0000-4000-8000-000000000002')`
    );
    await db.exec('RESET ROLE;');
    expect((await db.query('SELECT balance FROM accounts ORDER BY id')).rows).toEqual([
      { balance: '450' },
      { balance: '150' }
    ]);
    expect((await db.query('SELECT valid FROM statement_reconciliation_proofs')).rows).toEqual([
      { valid: true },
      { valid: true }
    ]);
    await db.exec(`UPDATE document_observations SET amount=null;`);
    await db.exec(`SET ROLE authenticated;`);
    await expect(
      db.query(
        `SELECT create_statement_transaction(gen_random_uuid(),'${doc}','${row}',null,'Invalid')`
      )
    ).rejects.toThrow(/evidence|linked/i);
  } finally {
    await db.close();
  }
}, 15000);
