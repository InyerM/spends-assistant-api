import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
it('reviews per-row categories and text with owner, contact and stale-edit guards', async () => {
  const db = new PGlite();
  const user = '00000000-0000-4000-8000-000000000001',
    src = '10000000-0000-4000-8000-000000000001',
    target = '10000000-0000-4000-8000-000000000002',
    cat = '20000000-0000-4000-8000-000000000001',
    other = '20000000-0000-4000-8000-000000000002';
  try {
    await db.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${user}'::uuid $$;CREATE FUNCTION has_accepted_required_terms() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE TABLE categories(id uuid,user_id uuid,slug text,name text,type text,is_active boolean,deleted_at timestamptz);
CREATE TABLE transactions(id uuid,user_id uuid,type text,category_id uuid,description text,notes text,raw_text text,date date,amount numeric,currency text,deleted_at timestamptz);
CREATE TABLE counterparties(id uuid,user_id uuid,display_name text,custom_name text);CREATE TABLE transaction_counterparties(transaction_id uuid,user_id uuid,contact_id uuid);
INSERT INTO categories VALUES('${cat}','${user}','restaurant','Food','expense',true,null),('${other}','${user}','gifts','Gifts','expense',true,null);
INSERT INTO transactions VALUES('${src}','${user}','expense','${cat}','Lunch','Meal','original evidence','2026-10-19',10,'COP',null),('${target}','${user}','expense',null,'Older',null,'immutable bank text','2026-10-01',20,'COP',null);
INSERT INTO counterparties VALUES('${src}','${user}','Shop',null);INSERT INTO transaction_counterparties VALUES('${src}','${user}','${src}'),('${target}','${user}','${src}');`);
    await db.exec(
      readFileSync('supabase/migrations/20261019000120_counterparty_review_context.sql', 'utf8')
    );
    await db.exec('SET ROLE authenticated;');
    const context = (
      await db.query<{ result: { source: { notes: string }; evidence: Array<{ id: string }> } }>(
        `SELECT counterparty_category_followup('${src}') result`
      )
    ).rows[0].result;
    expect(context.source.notes).toBe('Meal');
    expect(context.evidence.map((r) => r.id)).toContain(src);
    const patch = {
      id: target,
      category_id: other,
      description: 'Birthday gift',
      notes: 'Different purpose',
      expected_category_id: null,
      expected_description: 'Older',
      expected_notes: null
    };
    await db.query('SELECT apply_counterparty_review($1,$2,$3)', [
      src,
      cat,
      JSON.stringify([patch])
    ]);
    await expect(
      db.query('SELECT apply_counterparty_review($1,$2,$3)', [src, cat, JSON.stringify([patch])])
    ).rejects.toThrow(/changed/i);
    await db.exec('RESET ROLE;');
    expect(
      (
        await db.query(
          `SELECT category_id,description,notes,raw_text,amount FROM transactions WHERE id='${target}'`
        )
      ).rows
    ).toEqual([
      {
        category_id: other,
        description: 'Birthday gift',
        notes: 'Different purpose',
        raw_text: 'immutable bank text',
        amount: '20'
      }
    ]);
  } finally {
    await db.close();
  }
}, 15000);
