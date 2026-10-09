import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(
  new URL('../supabase/migrations/20261008000010_monthly_budgets.sql', import.meta.url)
);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const food = '33333333-3333-4333-8333-333333333333';
const dining = '44444444-4444-4444-8444-444444444444';
const investments = '55555555-5555-4555-8555-555555555555';
const loans = '66666666-6666-4666-8666-666666666666';
const foreignCategory = '77777777-7777-4777-8777-777777777777';
const incomeCategory = '88888888-8888-4888-8888-888888888888';

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION public.has_accepted_required_terms() RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT coalesce(nullif(current_setting('test.terms_accepted', true), ''), 'true')::boolean $$;
    CREATE TABLE public.categories(
      id uuid PRIMARY KEY, user_id uuid NOT NULL, parent_id uuid,
      name text NOT NULL, slug text NOT NULL, type text NOT NULL,
      is_active boolean NOT NULL DEFAULT true, deleted_at timestamptz
    );
    CREATE TABLE public.transactions(
      id uuid PRIMARY KEY, user_id uuid NOT NULL, category_id uuid,
      date date NOT NULL, amount numeric(15,2) NOT NULL, currency text,
      type text NOT NULL, deleted_at timestamptz, duplicate_status text
    );
    CREATE TABLE public.investment_trades(user_id uuid, source_transaction_id uuid);
    CREATE TABLE public.personal_receivable_events(user_id uuid, source_transaction_id uuid,
      kind text);
    CREATE TABLE public.manual_loan_events(user_id uuid, source_transaction_id uuid,
      kind text);
    CREATE TABLE public.relief_fund_entries(user_id uuid, transaction_id uuid, kind text);
    INSERT INTO auth.users VALUES ('${owner}'), ('${other}');
    INSERT INTO public.categories(id,user_id,parent_id,name,slug,type) VALUES
      ('${food}','${owner}',null,'Food','food','expense'),
      ('${dining}','${owner}','${food}','Dining','dining','expense'),
      ('${investments}','${owner}',null,'Investments','investments','expense'),
      ('${loans}','${owner}',null,'Loans','loans','expense'),
      ('${foreignCategory}','${other}',null,'Other user','other','expense'),
      ('${incomeCategory}','${owner}',null,'Salary','salary','income');
    INSERT INTO public.transactions VALUES
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','${owner}','${food}',
        '2026-10-02',100,'COP','expense',null,null),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','${owner}','${dining}',
        '2026-10-03',200,'COP','expense',null,null),
      ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','${owner}','${dining}',
        '2026-10-04',50,'COP','expense',null,'pending_review'),
      ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','${owner}','${dining}',
        '2026-10-05',60,'COP','expense',now(),null),
      ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','${owner}','${dining}',
        '2026-10-06',10,'USD','expense',null,null),
      ('ffffffff-ffff-4fff-8fff-ffffffffffff','${owner}','${dining}',
        '2026-10-07',30,'COP','expense',null,null),
      ('10101010-1010-4010-8010-101010101010','${owner}','${dining}',
        '2026-10-08',40,'COP','expense',null,null),
      ('20202020-2020-4020-8020-202020202020','${owner}','${dining}',
        '2026-10-09',50,'COP','expense',null,null),
      ('30303030-3030-4030-8030-303030303030','${owner}','${dining}',
        '2026-10-10',20,'COP','expense',null,null),
      ('99999999-9999-4999-8999-999999999999','${other}','${foreignCategory}',
        '2026-10-02',5000,'COP','expense',null,null);
    INSERT INTO public.relief_fund_entries VALUES
      ('${owner}','ffffffff-ffff-4fff-8fff-ffffffffffff','outlay');
    INSERT INTO public.personal_receivable_events VALUES
      ('${owner}','10101010-1010-4010-8010-101010101010','disbursement');
    INSERT INTO public.investment_trades VALUES
      ('${owner}','20202020-2020-4020-8020-202020202020');
    INSERT INTO public.manual_loan_events VALUES
      ('${owner}','30303030-3030-4030-8030-303030303030','payment');
    ALTER TABLE public.transactions ADD COLUMN description text NOT NULL DEFAULT 'Recorded expense';
  `);
  if (!migration) throw new Error('Monthly budget migration is missing');
  await db.exec(migration);
  await db.exec(
    readFileSync(
      new URL('../supabase/migrations/20261008000020_recurring_budgets.sql', import.meta.url),
      'utf8'
    )
  );
  await db.exec(
    readFileSync(
      new URL('../supabase/migrations/20261008000032_budget_edit_history.sql', import.meta.url),
      'utf8'
    )
  );
  await db.exec(
    readFileSync(
      new URL('../supabase/migrations/20261009000034_native_budget_commands.sql', import.meta.url),
      'utf8'
    )
  );
  return db;
}

async function command(
  db: PGlite,
  request: number,
  payload: Record<string, unknown>,
  user = owner
): Promise<Record<string, unknown>> {
  await db.exec(`SET request.jwt.claim.sub = '${user}'; SET ROLE authenticated;`);
  try {
    return (
      await db.query<{ result: Record<string, unknown> }>(
        'SELECT public.apply_native_budget_command($1::uuid,$2::jsonb) AS result',
        [`99999999-7777-4777-8777-${String(request).padStart(12, '0')}`, JSON.stringify(payload)]
      )
    ).rows[0].result;
  } finally {
    await db.exec('RESET ROLE');
  }
}
const create = {
  action: 'create',
  month: '2026-10-01',
  category_id: food,
  limit_cop: 500,
  repeat_monthly: true
};
describe('native budget command idempotency', () => {
  it('replays creates and category edits once without duplicate history', async () => {
    const db = await database();
    try {
      const transactionCount = (
        await db.query('SELECT count(*)::int AS count FROM public.transactions')
      ).rows;
      const first = await command(db, 1, create);
      expect(first.records).toEqual([
        expect.objectContaining({ user_id: owner, id: first.budget_id })
      ]);
      expect(first.skips).toEqual([]);
      expect(await command(db, 1, create)).toMatchObject({
        budget_id: first.budget_id,
        replayed: true
      });
      const edit = {
        ...create,
        action: 'update',
        budget_id: first.budget_id,
        month: '2026-11-01',
        category_id: dining,
        limit_cop: 800
      };
      const changed = await command(db, 2, edit);
      expect(await command(db, 2, edit)).toMatchObject({
        budget_id: changed.budget_id,
        replayed: true
      });
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.monthly_budget_edits')).rows
      ).toEqual([{ count: 1 }]);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.transactions')).rows
      ).toEqual(transactionCount);
      await expect(command(db, 1, { ...create, limit_cop: 900 })).rejects.toThrow(
        'different payload'
      );
    } finally {
      await db.close();
    }
  });
  it('stops recurrence once while retaining the previous month and denies foreign ownership', async () => {
    const db = await database();
    try {
      const first = await command(db, 1, create);
      const stop = { action: 'stop', budget_id: first.budget_id, month: '2026-11-01' };
      await expect(command(db, 2, stop, other)).rejects.toThrow('Budget not found');
      await command(db, 2, stop);
      expect(await command(db, 2, stop)).toMatchObject({ replayed: true });
      expect(
        (await db.query('SELECT ends_before::text,is_active FROM public.monthly_budgets')).rows
      ).toEqual([{ ends_before: '2026-11-01', is_active: true }]);
      await db.exec(`SET test.terms_accepted = 'false'`);
      await expect(command(db, 3, create)).rejects.toThrow('Terms acceptance required');
    } finally {
      await db.close();
    }
  });
});
