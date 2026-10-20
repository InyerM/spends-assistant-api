import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

it('applies only a confirmed unchanged owner expense category and audits without changing financial evidence', async () => {
  const db = new PGlite();
  const owner = '00000000-0000-4000-8000-000000000001';
  const other = '00000000-0000-4000-8000-000000000002';
  const id = '10000000-0000-4000-8000-000000000001';
  const category = '20000000-0000-4000-8000-000000000001';
  const account = '30000000-0000-4000-8000-000000000001';
  try {
    await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.uid',true),'')::uuid $$;
      CREATE FUNCTION has_accepted_required_terms() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.terms',true),'true')='true' $$;
      CREATE TABLE categories(id uuid,user_id uuid,type text,is_active boolean,deleted_at timestamptz);
      CREATE TABLE transactions(id uuid,user_id uuid,type text,category_id uuid,description text,notes text,account_id uuid,amount numeric,date date,raw_text text,deleted_at timestamptz,updated_at timestamptz);
      CREATE TABLE transaction_review_metadata_edits(user_id uuid,transaction_id uuid,before_state jsonb,after_state jsonb);
      INSERT INTO categories VALUES('${category}','${owner}','expense',true,null);
      INSERT INTO transactions VALUES('${id}','${owner}','expense',null,'YouTube Premium',null,'${account}',10000,'2026-10-19','Original bank message',null,now());
      SELECT set_config('test.uid','${owner}',false);`);
    const path = 'supabase/migrations/20261020000040_expense_category_review.sql';
    if (existsSync(path)) await db.exec(readFileSync(path, 'utf8'));
    const expected = {
      category_id: null,
      description: 'YouTube Premium',
      notes: null,
      account_id: account
    };
    const apply = (snapshot = expected) =>
      db.query('SELECT review_expense_category($1,$2,$3)', [
        id,
        category,
        JSON.stringify(snapshot)
      ]);
    await db.exec(`SELECT set_config('test.uid','${other}',false)`);
    await expect(apply()).rejects.toThrow('Transaction not found');
    await db.exec(
      `SELECT set_config('test.uid','${owner}',false); SELECT set_config('test.terms','false',false)`
    );
    await expect(apply()).rejects.toThrow('Authentication required');
    await db.exec("SELECT set_config('test.terms','true',false)");
    await expect(apply({ ...expected, description: 'Stale description' })).rejects.toThrow(
      'Movement changed'
    );
    await db.exec("UPDATE categories SET type='income'");
    await expect(apply()).rejects.toThrow('Category not found');
    await db.exec("UPDATE categories SET type='expense'; UPDATE transactions SET type='transfer'");
    await expect(apply()).rejects.toThrow('Movement changed');
    await db.exec("UPDATE transactions SET type='expense'");
    await apply();
    expect(
      (
        await db.query(
          'SELECT category_id,amount,date::text,raw_text,description,notes,account_id FROM transactions'
        )
      ).rows
    ).toEqual([
      {
        category_id: category,
        amount: '10000',
        date: '2026-10-19',
        raw_text: 'Original bank message',
        description: 'YouTube Premium',
        notes: null,
        account_id: account
      }
    ]);
    expect(
      (await db.query('SELECT before_state,after_state FROM transaction_review_metadata_edits'))
        .rows
    ).toEqual([
      {
        before_state: { category_id: null, description: 'YouTube Premium', notes: null },
        after_state: { category_id: category, description: 'YouTube Premium', notes: null }
      }
    ]);
    await db.exec(
      readFileSync('supabase/migrations/20261020000090_expense_review_metadata.sql', 'utf8')
    );
    const snapshot = { ...expected, category_id: category };
    const review = (changes: unknown, context: unknown = snapshot) =>
      db.query('SELECT review_expense_metadata($1,$2,$3)', [
        id,
        JSON.stringify(changes),
        JSON.stringify(context)
      ]);
    await expect(review({ amount: 1 })).rejects.toThrow(/Invalid review changes/);
    await expect(review({ description: '' })).rejects.toThrow(/description/i);
    await expect(review({ notes: 'x'.repeat(1501) })).rejects.toThrow(/notes/i);
    await expect(
      review({ description: 'Video subscription' }, { ...snapshot, notes: 'Stale' })
    ).rejects.toThrow(/Movement changed/);
    await db.exec(`SELECT set_config('test.uid','${other}',false)`);
    await expect(review({ description: 'Video subscription' })).rejects.toThrow(
      /Transaction not found/
    );
    await db.exec(`SELECT set_config('test.uid','${owner}',false)`);
    await review({ description: 'Video subscription', notes: 'Monthly video service' });
    expect(
      (
        await db.query(
          'SELECT description,notes,category_id,amount,date::text,raw_text,account_id FROM transactions'
        )
      ).rows
    ).toEqual([
      {
        description: 'Video subscription',
        notes: 'Monthly video service',
        category_id: category,
        amount: '10000',
        date: '2026-10-19',
        raw_text: 'Original bank message',
        account_id: account
      }
    ]);
    await expect(review({ description: 'Stale overwrite' })).rejects.toThrow(/Movement changed/);
    const next = { ...snapshot, description: 'Video subscription', notes: 'Monthly video service' };
    await review({ notes: null }, next);
    expect((await db.query('SELECT notes FROM transactions')).rows).toEqual([{ notes: null }]);
    await expect(apply()).rejects.toThrow('Movement changed');
    expect((await db.query('SELECT count(*) FROM transaction_review_metadata_edits')).rows).toEqual(
      [{ count: 3 }]
    );
  } finally {
    await db.close();
  }
}, 15000);
