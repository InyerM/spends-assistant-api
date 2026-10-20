import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
it('finds all owner category references including rules and historical postings without exposing another owner', async () => {
  const db = new PGlite();
  try {
    await db.exec(
      `CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;CREATE FUNCTION has_accepted_required_terms() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.terms',true),'true')='true' $$;CREATE TABLE categories(id uuid,user_id uuid,deleted_at timestamptz);CREATE TABLE transactions(category_id uuid,user_id uuid,deleted_at timestamptz);CREATE TABLE monthly_budgets(category_id uuid,user_id uuid);CREATE TABLE common_expenses(category_id uuid,user_id uuid);CREATE TABLE planned_expenses(category_id uuid,user_id uuid);CREATE TABLE automation_rules(user_id uuid,actions jsonb);`
    );
    const owner = '00000000-0000-4000-8000-000000000001',
      other = '00000000-0000-4000-8000-000000000002';
    const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-00000000001${i}`);
    for (const [index, id] of ids.entries())
      await db.query('INSERT INTO categories VALUES($1,$2,NULL)', [
        id,
        index === 5 ? other : owner
      ]);
    for (const [index, table] of [
      'transactions',
      'monthly_budgets',
      'common_expenses',
      'planned_expenses'
    ].entries())
      await db.query(`INSERT INTO ${table}(category_id,user_id) VALUES($1,$2)`, [
        ids[index],
        owner
      ]);
    await db.query('UPDATE transactions SET deleted_at=now()');
    await db.query('INSERT INTO automation_rules VALUES($1,$2)', [
      owner,
      JSON.stringify({ set_category: ids[4] })
    ]);
    await db.query('INSERT INTO transactions VALUES($1,$2,NULL)', [ids[5], other]);
    const path = 'supabase/migrations/20261020000020_category_usage.sql';
    if (existsSync(path)) await db.exec(readFileSync(path, 'utf8'));
    await db.query("SELECT set_config('test.uid',$1,false)", [owner]);
    expect(
      (
        await db.query<{ value: { used_ids: string[] } }>(
          'SELECT category_usage_summary() AS value'
        )
      ).rows[0].value.used_ids.sort()
    ).toEqual(ids.slice(0, 5));
    await db.query("SELECT set_config('test.terms','false',false)");
    await expect(db.query('SELECT category_usage_summary()')).rejects.toThrow(
      'Authentication required'
    );
  } finally {
    await db.close();
  }
}, 15000);
