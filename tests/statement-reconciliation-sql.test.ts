import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

it('audits statement links without posting, isolates owners and invalidates changed finances', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      CREATE TABLE auth.users(id uuid primary key);
      CREATE TABLE accounts(id uuid primary key,user_id uuid,currency text,deleted_at timestamptz,is_active boolean,balance numeric);
      CREATE TABLE documents(id uuid primary key,user_id uuid,document_type text,status text,archived_at timestamptz,file_name text);
      CREATE TABLE document_observations(id uuid primary key,user_id uuid,document_id uuid,amount numeric,currency text,occurred_at_text text,status text,description text);
      CREATE TABLE transactions(id uuid primary key,user_id uuid,account_id uuid,transfer_to_account_id uuid,currency text,amount numeric,date date,type text,deleted_at timestamptz,description text,parsed_data jsonb);
      INSERT INTO auth.users VALUES ('00000000-0000-4000-8000-000000000001');
      INSERT INTO accounts VALUES ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','COP',null,true,500);
      INSERT INTO documents VALUES ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','statement','extracted',null,'Statement.pdf');
      INSERT INTO document_observations VALUES ('30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',-100,'COP','2026-09-11','pending','Lunch');
      INSERT INTO transactions VALUES ('40000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',null,'COP',100,'2026-09-11','expense',null,'Lunch',null);`);
    await db.exec(
      readFileSync('supabase/migrations/20261009000050_statement_reconciliation.sql', 'utf8')
    );
    await db.exec(
      readFileSync(
        'supabase/migrations/20261009000051_statement_reconciliation_commands.sql',
        'utf8'
      )
    );
    await db.exec(
      `SET request.jwt.claim.sub='00000000-0000-4000-8000-000000000001'; SET ROLE authenticated;`
    );
    await db.query(
      `SELECT set_statement_reconciliation_scope('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','2026-09-01','2026-09-30')`
    );
    const call = `SELECT confirm_statement_reconciliation('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001') AS id`;
    await expect(
      db.query(
        `SELECT confirm_statement_reconciliation('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002')`
      )
    ).rejects.toThrow(/not found/);
    const queuedCall = `SELECT apply_statement_reconciliation_command('50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','{"action":"confirm","observation_id":"30000000-0000-4000-8000-000000000001","transaction_id":"40000000-0000-4000-8000-000000000001"}')`;
    await db.query(queuedCall);
    const first = await db.query(call);
    await expect(
      db.query(
        `SELECT set_statement_reconciliation_scope('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','2026-08-01','2026-08-31')`
      )
    ).rejects.toThrow(/Undo/);
    expect((await db.query(call)).rows).toEqual(first.rows);
    expect((await db.query(`SELECT valid FROM statement_reconciliation_proofs`)).rows).toEqual([
      { valid: true }
    ]);
    await expect(db.exec(`DELETE FROM statement_reconciliation_links`)).rejects.toThrow(
      /permission denied/
    );
    await db.exec(`RESET ROLE; UPDATE transactions SET description='Edited note';`);
    expect((await db.query(`SELECT valid FROM statement_reconciliation_proofs`)).rows).toEqual([
      { valid: true }
    ]);
    await expect(
      db.exec(`UPDATE statement_reconciliation_links SET transaction_snapshot='{}'`)
    ).rejects.toThrow(/immutable/);
    await db.exec(`UPDATE transactions SET amount=101;`);
    await expect(
      db.exec(
        `INSERT INTO transactions(id,user_id,parsed_data) VALUES ('40000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','{"document_id":"20000000-0000-4000-8000-000000000001"}')`
      )
    ).rejects.toThrow(/not transaction intake/);
    expect((await db.query(`SELECT valid FROM statement_reconciliation_proofs`)).rows).toEqual([
      { valid: false }
    ]);
    await db.exec(`SET ROLE authenticated;`);
    await expect(db.query(call)).rejects.toThrow(/does not match/);
    await db.query(
      `SELECT undo_statement_reconciliation('${(first.rows[0] as { id: string }).id}')`
    );
    expect((await db.query(`SELECT * FROM statement_reconciliation_proofs`)).rows).toEqual([]);
    await db.query(queuedCall);
    expect((await db.query(`SELECT * FROM statement_reconciliation_proofs`)).rows).toEqual([]);
    await db.exec(`RESET ROLE;`);
    expect((await db.query(`SELECT balance FROM accounts`)).rows).toEqual([{ balance: '500' }]);
    await db.exec(
      `SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';`
    );
    expect((await db.query(`SELECT * FROM statement_reconciliation_proofs`)).rows).toEqual([]);
    expect((await db.query(`SELECT * FROM statement_reconciliation_proofs`)).rows).toEqual([]);
    await expect(db.query(call)).rejects.toThrow(/not found/i);
  } finally {
    await db.close();
  }
});
