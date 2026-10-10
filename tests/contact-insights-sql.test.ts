import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('ranks expenses by currency across the full owner ledger and excludes foreign, deleted and internal movements', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-4000-8000-000000000001'::uuid $$;
 CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
 CREATE FUNCTION has_accepted_required_terms() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
 CREATE TABLE counterparties(id uuid,user_id uuid,custom_name text,display_name text);
 CREATE TABLE transaction_counterparties(transaction_id uuid,user_id uuid,contact_id uuid);
 CREATE TABLE transactions(id uuid,user_id uuid,type text,currency text,amount numeric,date date,deleted_at timestamptz,transfer_id uuid,transfer_to_account_id uuid);
 CREATE FUNCTION list_counterparties_sorted(text,integer,integer,text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"items":[],"count":1,"scan":{}}'::jsonb $$;
 INSERT INTO counterparties VALUES('00000000-0000-4000-8000-000000000010',auth.uid(),NULL,'Shop');
 INSERT INTO transactions VALUES('00000000-0000-4000-8000-000000000020',auth.uid(),'expense','COP',500,'2026-10-01',NULL,NULL,NULL),('00000000-0000-4000-8000-000000000021',auth.uid(),'expense','USD',10,'2026-10-02',NULL,NULL,NULL),('00000000-0000-4000-8000-000000000022',auth.uid(),'expense','COP',999,'2026-10-03',now(),NULL,NULL),('00000000-0000-4000-8000-000000000023','00000000-0000-4000-8000-000000000002','expense','COP',777,'2026-10-03',NULL,NULL,NULL),('00000000-0000-4000-8000-000000000024',auth.uid(),'expense','COP',999,'2026-10-03',NULL,'00000000-0000-4000-8000-000000000090',NULL);
 INSERT INTO transaction_counterparties SELECT id,user_id,'00000000-0000-4000-8000-000000000010'::uuid FROM transactions;`);
    await db.exec(readFileSync('supabase/migrations/20261010000057_contact_insights.sql', 'utf8'));
    const result = await db.query<{
      summary: { spending: Array<{ currency: string; amount: number }> };
    }>('SELECT contact_insights() AS summary');
    expect(result.rows[0].summary.spending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ currency: 'COP', amount: 500 }),
        expect.objectContaining({ currency: 'USD', amount: 10 })
      ])
    );
    expect(result.rows[0].summary.spending).toHaveLength(2);
  } finally {
    await db.close();
  }
});
