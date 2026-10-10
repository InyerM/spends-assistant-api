import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
const owner = '11111111-1111-4111-8111-111111111111';
it('isolates planning, replays identical commands, keeps progress separate from money, and preserves calendar anchors', async () => {
  const db = new PGlite();
  try {
    await db.exec(
      `CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;CREATE FUNCTION public.has_accepted_required_terms() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;CREATE TABLE accounts(id uuid PRIMARY KEY,user_id uuid,is_active boolean,deleted_at timestamptz,currency text);CREATE TABLE categories(id uuid PRIMARY KEY,user_id uuid,is_active boolean,deleted_at timestamptz,type text);CREATE TABLE transactions(id uuid PRIMARY KEY,amount numeric);CREATE TABLE owner_notifications(user_id uuid,notice_key text,kind text,source_id uuid,label text,UNIQUE(user_id,notice_key));CREATE FUNCTION public.confirm_manual_transaction(uuid,jsonb,boolean,uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"status":"created","transaction":{"id":"33333333-3333-4333-8333-333333333333"}}'::jsonb $$;INSERT INTO auth.users VALUES('${owner}');SELECT set_config('request.jwt.claim.sub','${owner}',false);`
    );
    await db.exec(readFileSync('supabase/migrations/20261010000054_personal_planning.sql', 'utf8'));
    expect(
      (await db.query("SELECT next_planned_date('2028-01-31','monthly',1,31)::text AS d")).rows[0]
    ).toMatchObject({ d: '2028-02-29' });
    expect(
      (await db.query("SELECT next_planned_date('2028-02-29','monthly',1,31)::text AS d")).rows[0]
    ).toMatchObject({ d: '2028-03-31' });
    const payload = {
      action: 'save_goal',
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Emergency fund',
      currency: 'COP',
      target_amount: 1000,
      saved_amount: 100,
      due_date: null
    };
    const request = '55555555-5555-4555-8555-555555555555';
    await db.query('SELECT apply_planning_command($1,$2)', [request, JSON.stringify(payload)]);
    await db.query('SELECT apply_planning_command($1,$2)', [request, JSON.stringify(payload)]);
    expect((await db.query('SELECT count(*)::int n FROM savings_goals')).rows[0]).toEqual({ n: 1 });
    expect((await db.query('SELECT count(*)::int n FROM transactions')).rows[0]).toEqual({ n: 0 });
    await expect(
      db.query('SELECT apply_planning_command($1,$2)', [
        request,
        JSON.stringify({ ...payload, saved_amount: 200 })
      ])
    ).rejects.toThrow(/different payload/);
    await db.exec(
      "SELECT set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false)"
    );
    await expect(
      db.query('SELECT apply_planning_command($1,$2)', [
        '66666666-6666-4666-8666-666666666666',
        JSON.stringify(payload)
      ])
    ).rejects.toThrow(/not found|owner/);
  } finally {
    await db.close();
  }
});

it('processes an authorized due expense once, keeps duplicate conflicts for review and blocks authenticated scheduler execution', async () => {
  const db = new PGlite();
  try {
    await db.exec(
      `CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;CREATE FUNCTION public.has_accepted_required_terms() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;CREATE TABLE accounts(id uuid PRIMARY KEY,user_id uuid,is_active boolean,deleted_at timestamptz,currency text);CREATE TABLE categories(id uuid PRIMARY KEY,user_id uuid,is_active boolean,deleted_at timestamptz,type text);CREATE TABLE transactions(id uuid PRIMARY KEY,amount numeric);CREATE TABLE owner_notifications(user_id uuid,notice_key text,kind text,source_id uuid,label text,UNIQUE(user_id,notice_key));CREATE TABLE calls(payload jsonb);CREATE FUNCTION public.confirm_manual_transaction(p_id uuid,p_data jsonb,p_force boolean,p_replace uuid) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN IF p_force OR p_replace IS NOT NULL THEN RAISE EXCEPTION 'Unsafe scheduler';END IF;INSERT INTO public.calls VALUES(p_data);INSERT INTO public.transactions VALUES(p_id,10) ON CONFLICT DO NOTHING;RETURN jsonb_build_object('status','created','transaction',jsonb_build_object('id',p_id));END;$$;INSERT INTO auth.users VALUES('${owner}');SELECT set_config('request.jwt.claim.sub','${owner}',false);INSERT INTO accounts VALUES('77777777-7777-4777-8777-777777777777','${owner}',true,NULL,'COP');`
    );
    await db.exec(readFileSync('supabase/migrations/20261010000054_personal_planning.sql', 'utf8'));
    await db.exec(
      readFileSync('supabase/migrations/20261010000055_scheduled_expense_processing.sql', 'utf8')
    );
    const payload = {
      action: 'save_schedule',
      id: '88888888-8888-4888-8888-888888888888',
      name: 'Rent',
      amount: 10,
      account_id: '77777777-7777-4777-8777-777777777777',
      category_id: null,
      cadence: 'monthly',
      interval_days: 1,
      next_due: new Date().toISOString().slice(0, 10),
      due_time: '00:00',
      timezone: 'UTC',
      automatic: true
    };
    await db.query('SELECT apply_planning_command($1,$2)', [
      '99999999-9999-4999-8999-999999999999',
      JSON.stringify(payload)
    ]);
    await db.query('SELECT process_planned_expenses(1)');
    await db.query('SELECT process_planned_expenses(1)');
    expect(
      (await db.query('SELECT count(*)::int n FROM planned_expense_postings')).rows[0]
    ).toEqual({ n: 1 });
    expect(
      (await db.query("SELECT count(DISTINCT payload->>'date')::int n FROM calls")).rows[0]
    ).toEqual({ n: 1 });
    expect((await db.query('SELECT month_day FROM planned_expenses')).rows[0]).toEqual({
      month_day: new Date().getUTCDate()
    });
    await db.exec(
      'CREATE OR REPLACE FUNCTION public.confirm_manual_transaction(p_id uuid,p_data jsonb,p_force boolean,p_replace uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT \'{"status":"duplicate"}\'::jsonb $$'
    );
    await db.exec(
      "UPDATE planned_expenses SET next_due=(now() AT TIME ZONE 'UTC')::date,automatic=true"
    );
    await db.query('SELECT process_planned_expenses(1)');
    expect((await db.query('SELECT automatic,last_error FROM planned_expenses')).rows[0]).toEqual({
      automatic: false,
      last_error: '23505'
    });
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM owner_notifications WHERE kind='scheduled_review'"
        )
      ).rows[0]
    ).toEqual({ n: 1 });
    expect((await db.query('SELECT count(*)::int n FROM transactions')).rows[0]).toEqual({ n: 1 });
    await db.exec('SET ROLE authenticated');
    await expect(db.query('SELECT process_planned_expenses(1)')).rejects.toThrow(
      /permission denied/
    );
  } finally {
    await db.close();
  }
});
