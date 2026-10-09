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
  return db;
}

async function asOwner(db: PGlite, user = owner): Promise<void> {
  await db.exec(`SET request.jwt.claim.sub = '${user}'; SET ROLE authenticated;`);
}

async function upsert(db: PGlite, categoryId = food, limit = 500): Promise<string> {
  const result = await db.query<{ upsert_monthly_budget: string }>(
    'SELECT public.upsert_monthly_budget($1::date,$2::uuid,$3::numeric)',
    ['2026-10-01', categoryId, limit]
  );
  return result.rows[0].upsert_monthly_budget;
}

async function status(db: PGlite): Promise<Record<string, unknown>[]> {
  const result = await db.query<Record<string, unknown>>(
    'SELECT * FROM public.get_monthly_budget_status($1::date)',
    ['2026-10-01']
  );
  return result.rows;
}

describe('monthly COP budgets', () => {
  it('repeats monthly, allows one-month overrides, and preserves history when stopped', async () => {
    const db = await database();
    try {
      await asOwner(db);
      const created = await db.query<{ upsert_monthly_budget: string }>(
        'SELECT public.upsert_monthly_budget($1::date,$2::uuid,$3::numeric,$4::boolean)',
        ['2026-10-01', food, 500, true]
      );
      const id = created.rows[0].upsert_monthly_budget;
      const future = () =>
        db.query('SELECT * FROM public.get_monthly_budget_status($1::date)', ['2026-12-01']);
      expect((await future()).rows).toMatchObject([
        { budget_id: id, repeat_monthly: true, spent_cop: '0.00' }
      ]);
      await db.query(
        'SELECT public.upsert_monthly_budget($1::date,$2::uuid,$3::numeric,$4::boolean)',
        ['2026-11-01', food, 700, false]
      );
      const november = await db.query('SELECT * FROM public.get_monthly_budget_status($1::date)', [
        '2026-11-01'
      ]);
      expect(november.rows).toMatchObject([{ limit_cop: '700.00', repeat_monthly: false }]);
      await db.query('SELECT public.stop_monthly_budget($1::uuid,$2::date)', [id, '2026-12-01']);
      expect((await future()).rows).toEqual([]);
      expect(await status(db)).toMatchObject([{ budget_id: id, spent_cop: '300.00' }]);
    } finally {
      await db.close();
    }
  });

  it('does not resurrect a superseded recurring limit after stopping its replacement', async () => {
    const db = await database();
    try {
      await asOwner(db);
      await db.query(
        'SELECT public.upsert_monthly_budget($1::date,$2::uuid,$3::numeric,$4::boolean)',
        ['2026-10-01', food, 500, true]
      );
      const next = await db.query<{ upsert_monthly_budget: string }>(
        'SELECT public.upsert_monthly_budget($1::date,$2::uuid,$3::numeric,$4::boolean)',
        ['2026-11-01', food, 700, true]
      );
      await db.query('SELECT public.stop_monthly_budget($1::uuid,$2::date)', [
        next.rows[0].upsert_monthly_budget,
        '2026-12-01'
      ]);
      const december = await db.query('SELECT * FROM public.get_monthly_budget_status($1::date)', [
        '2026-12-01'
      ]);
      expect(december.rows).toEqual([]);
      expect(await status(db)).toMatchObject([{ limit_cop: '500.00' }]);
    } finally {
      await db.close();
    }
  });

  it('keeps a historical edit bounded by the newer recurring rule', async () => {
    const db = await database();
    try {
      await asOwner(db);
      const save = (month: string, limit: number) =>
        db.query<{ upsert_monthly_budget: string }>(
          'SELECT public.upsert_monthly_budget($1::date,$2::uuid,$3::numeric,$4::boolean)',
          [month, food, limit, true]
        );
      await save('2026-10-01', 500);
      const next = await save('2026-11-01', 700);
      await save('2026-10-01', 550);
      await db.query('SELECT public.stop_monthly_budget($1::uuid,$2::date)', [
        next.rows[0].upsert_monthly_budget,
        '2026-12-01'
      ]);
      expect(
        (await db.query('SELECT * FROM public.get_monthly_budget_status($1::date)', ['2026-12-01']))
          .rows
      ).toEqual([]);
      expect(await status(db)).toMatchObject([{ limit_cop: '550.00' }]);
    } finally {
      await db.close();
    }
  });

  it('includes child categories once and reports excluded or unresolved expense coverage', async () => {
    const db = await database();
    try {
      await asOwner(db);
      const id = await upsert(db);
      expect(await status(db)).toMatchObject([
        {
          budget_id: id,
          category_id: food,
          limit_cop: '500.00',
          spent_cop: '300.00',
          pending_count: 1,
          unknown_currency_count: 1,
          excluded_count: 4,
          threshold: 'none'
        }
      ]);
    } finally {
      await db.close();
    }
  });

  it('updates the same monthly limit and shows 80% and 100% thresholds', async () => {
    const db = await database();
    try {
      await asOwner(db);
      const id = await upsert(db, food, 375);
      expect((await status(db))[0].threshold).toBe('80');
      expect(await upsert(db, food, 300)).toBe(id);
      expect(await status(db)).toMatchObject([{ threshold: '100', limit_cop: '300.00' }]);
    } finally {
      await db.close();
    }
  });

  it('returns only the exact movements contributing to the reported total', async () => {
    const db = await database();
    try {
      await asOwner(db);
      await upsert(db);
      const [budget] = await status(db);
      const contributing = budget.contributing_transactions as Array<{
        id: string;
        amount: number;
        date: string;
      }>;
      expect(contributing.map((row) => row.id)).toEqual([
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      ]);
      expect(contributing.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(
        Number(budget.spent_cop)
      );
    } finally {
      await db.close();
    }
  });

  it('rejects another owner, nonexpense, financial principal, invalid month and limit', async () => {
    const db = await database();
    try {
      await asOwner(db);
      await expect(upsert(db, foreignCategory)).rejects.toThrow(/category/i);
      await expect(upsert(db, incomeCategory)).rejects.toThrow(/category/i);
      await expect(upsert(db, investments)).rejects.toThrow(/categor/i);
      await expect(upsert(db, loans)).rejects.toThrow(/categor/i);
      await expect(upsert(db, food, 0)).rejects.toThrow(/limit/i);
      await expect(
        db.query('SELECT public.upsert_monthly_budget($1::date,$2::uuid,$3::numeric)', [
          '2026-10-02',
          food,
          500
        ])
      ).rejects.toThrow(/month/i);
    } finally {
      await db.close();
    }
  });

  it('returns only owned budgets and prevents direct budget writes', async () => {
    const db = await database();
    try {
      await asOwner(db);
      await upsert(db);
      await asOwner(db, other);
      expect(await status(db)).toEqual([]);
      await expect(db.query('UPDATE public.monthly_budgets SET limit_cop = 1')).rejects.toThrow(
        /permission denied/i
      );
    } finally {
      await db.close();
    }
  });

  it('deactivates an owned budget without deleting its history and can reactivate it', async () => {
    const db = await database();
    try {
      await asOwner(db);
      const id = await upsert(db);
      await asOwner(db, other);
      expect(
        (await db.query('SELECT public.deactivate_monthly_budget($1::uuid) AS changed', [id]))
          .rows[0]
      ).toMatchObject({ changed: false });
      await asOwner(db);
      expect(
        (await db.query('SELECT public.deactivate_monthly_budget($1::uuid) AS changed', [id]))
          .rows[0]
      ).toMatchObject({ changed: true });
      expect(await status(db)).toEqual([]);
      expect(await upsert(db)).toBe(id);
      expect(await status(db)).toHaveLength(1);
    } finally {
      await db.close();
    }
  });
});
