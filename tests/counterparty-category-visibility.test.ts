import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('includes shared categories without exposing another owner category or contact', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-4000-8000-000000000001'::uuid $$;
 CREATE TABLE categories(id uuid,user_id uuid,name text,translations jsonb);
 CREATE TABLE counterparties(id uuid,user_id uuid);
 CREATE TABLE transaction_counterparties(user_id uuid,transaction_id uuid,contact_id uuid);
 CREATE TABLE transactions(id uuid,user_id uuid,currency text,type text,amount numeric,category_id uuid,date date,description text,deleted_at timestamptz);
 INSERT INTO counterparties VALUES('00000000-0000-4000-8000-000000000010',auth.uid());
 INSERT INTO categories VALUES('00000000-0000-4000-8000-000000000020',NULL,'Food','{"es":"Alimentación"}'),('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000002','Private category',NULL);
 INSERT INTO transactions VALUES('00000000-0000-4000-8000-000000000030',auth.uid(),'COP','expense',100,'00000000-0000-4000-8000-000000000020','2026-10-10','Lunch',NULL),('00000000-0000-4000-8000-000000000031',auth.uid(),'COP','expense',100,'00000000-0000-4000-8000-000000000021','2026-10-10','Other',NULL);
 INSERT INTO transaction_counterparties SELECT auth.uid(),id,'00000000-0000-4000-8000-000000000010'::uuid FROM transactions;`);
    const path = 'supabase/migrations/20261010000053_counterparty_shared_categories.sql';
    await db.exec(readFileSync(path, 'utf8'));
    const rows = await db.query<{
      detail: { categories: Array<{ name: string | null; translations: { es: string } | null }> };
    }>("SELECT counterparty_detail('00000000-0000-4000-8000-000000000010') detail");
    expect(rows.rows[0].detail.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Food', translations: { es: 'Alimentación' } }),
        expect.objectContaining({ name: null })
      ])
    );
    expect(JSON.stringify(rows.rows)).not.toContain('Private category');
    expect(
      (await db.query("SELECT counterparty_detail('00000000-0000-4000-8000-000000000011') detail"))
        .rows[0]
    ).toEqual({ detail: null });
  } finally {
    await db.close();
  }
});
