import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
const owner = '00000000-0000-4000-8000-000000000001',
  other = '00000000-0000-4000-8000-000000000002',
  account = '10000000-0000-4000-8000-000000000001',
  funding = '10000000-0000-4000-8000-000000000002',
  doc = '20000000-0000-4000-8000-000000000001',
  row = '30000000-0000-4000-8000-000000000001',
  key = '40000000-0000-4000-8000-000000000001';
it('posts and reconciles a reviewed cross-currency card payment atomically, replays once, and reverses both balances on deletion', async () => {
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
    await db.exec("ALTER TABLE documents ADD COLUMN mime_type text DEFAULT 'application/pdf';");
    await db.exec(
      readFileSync(
        'supabase/migrations/20261019000020_statement_currency_scopes_and_metadata.sql',
        'utf8'
      )
    );

    await db.exec(`ALTER TABLE transactions ADD COLUMN source_currency text,ADD COLUMN source_amount numeric,ADD COLUMN destination_amount numeric,ADD COLUMN fx_rate numeric,ADD COLUMN fx_rate_source text,ADD COLUMN fx_effective_date date;
GRANT SELECT ON transactions TO authenticated; CREATE TABLE transaction_deletion_decisions(user_id uuid,transaction_id uuid,before_state jsonb);
UPDATE document_observations SET amount=5,occurred_at_text='2026-09-01',description='Card payment',source_excerpt='01/09/2026 CARD PAYMENT 5.00 USD'; INSERT INTO accounts VALUES('${funding}','${owner}','COP',null,true,100000);`);
    const path = 'supabase/migrations/20261020000060_statement_currency_transfers.sql';
    if (existsSync(path)) await db.exec(readFileSync(path, 'utf8'));
    await db.exec(
      `CREATE TRIGGER enforce_currency BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION enforce_transaction_currency(); SET request.jwt.claim.sub='${owner}'; SET ROLE authenticated;`
    );
    await db.query(
      `SELECT set_statement_currency_scope('${doc}','${account}','2026-09-01','2026-09-30','USD')`
    );
    const call = (amount = 20000) =>
      db.query(`SELECT create_converted_statement_transaction($1,$2,$3,$4,$5,$6) result`, [
        key,
        doc,
        row,
        'Card payment',
        funding,
        amount
      ]);
    await expect(call(0)).rejects.toThrow(/Invalid reviewed conversion/);
    await db.exec(
      `RESET ROLE; CREATE FUNCTION fail_conversion_balance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic conversion failure'; END $$; CREATE TRIGGER fail_conversion_balance BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION fail_conversion_balance(); SET ROLE authenticated;`
    );
    await expect(call()).rejects.toThrow(/Synthetic conversion failure/);
    await db.exec('RESET ROLE; DROP TRIGGER fail_conversion_balance ON accounts;');
    expect((await db.query('SELECT count(*) FROM transactions')).rows).toEqual([{ count: 0 }]);
    expect((await db.query('SELECT count(*) FROM statement_transaction_requests')).rows).toEqual([
      { count: 0 }
    ]);
    await db.exec('SET ROLE authenticated;');
    const first = await call();
    expect((await call()).rows).toEqual(first.rows);
    await expect(call(21000)).rejects.toThrow(/Request key/i);
    expect((await db.query('SELECT valid FROM statement_reconciliation_proofs')).rows).toEqual([
      { valid: true }
    ]);
    await db.exec('RESET ROLE');
    expect((await db.query('SELECT balance FROM accounts ORDER BY id')).rows).toEqual([
      { balance: '505' },
      { balance: '80000' }
    ]);
    expect(
      (
        await db.query(
          'SELECT amount,currency,destination_amount,source_currency,source_amount,fx_rate::float8 AS fx_rate,raw_text FROM transactions'
        )
      ).rows
    ).toEqual([
      {
        amount: '20000',
        currency: 'COP',
        destination_amount: '5',
        source_currency: 'USD',
        source_amount: '5',
        fx_rate: 4000,
        raw_text: '01/09/2026 CARD PAYMENT 5.00 USD'
      }
    ]);
    expect((await db.query('SELECT transactions_count FROM usage_tracking')).rows).toEqual([
      { transactions_count: 1 }
    ]);
    await expect(db.exec('UPDATE transactions SET amount=21000')).rejects.toThrow(
      /Converted transfer/i
    );
    await db.exec(`SET request.jwt.claim.sub='${other}'; SET ROLE authenticated;`);
    await expect(call()).rejects.toThrow(/not found/i);
    await db.exec(`SET request.jwt.claim.sub='${owner}';`);
    await db.query('SELECT soft_delete_transactions(ARRAY[(SELECT id FROM transactions)])');
    await db.exec('RESET ROLE');
    expect((await db.query('SELECT balance FROM accounts ORDER BY id')).rows).toEqual([
      { balance: '500' },
      { balance: '100000' }
    ]);
    await db.exec(`SET ROLE authenticated;`);
    expect((await db.query('SELECT valid FROM statement_reconciliation_proofs')).rows).toEqual([
      { valid: false }
    ]);
  } finally {
    await db.close();
  }
}, 15000);
