import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../supabase/migrations/20260929000100_atomic_ai_parse_quota.sql',
  import.meta.url
);
const user1 = '11111111-1111-4111-8111-111111111111';
const user2 = '22222222-2222-4222-8222-222222222222';

async function reserve(db: PGlite, userId = user1) {
  const result = await db.query<{ allowed: boolean; used: number; limit: number }>(
    'SELECT * FROM public.reserve_ai_parse($1::uuid)',
    [userId]
  );
  return result.rows[0];
}

describe('atomic AI parse quota migration', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE TABLE public.subscriptions (
        user_id uuid PRIMARY KEY REFERENCES auth.users(id),
        plan text NOT NULL,
        status text NOT NULL
      );
      GRANT ALL ON public.subscriptions TO authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.subscriptions TO service_role;
      CREATE TABLE public.app_settings (key text PRIMARY KEY, value jsonb NOT NULL);
      CREATE TABLE public.usage_tracking (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES auth.users(id),
        month text NOT NULL,
        ai_parses_used integer NOT NULL DEFAULT 0,
        ai_parses_limit integer NOT NULL DEFAULT 15,
        transactions_count integer NOT NULL DEFAULT 0,
        transactions_limit integer NOT NULL DEFAULT 50,
        updated_at timestamptz DEFAULT now(),
        UNIQUE (user_id, month)
      );
      GRANT ALL ON public.usage_tracking TO authenticated;
      INSERT INTO auth.users (id) VALUES ('${user1}'), ('${user2}');
      INSERT INTO public.app_settings (key, value) VALUES
        ('free_ai_parses_limit', '2'),
        ('free_transactions_limit', '70');
    `);
    const migration = readFileSync(migrationUrl, 'utf8');
    await db.exec(migration);
  });

  afterEach(async () => db.close());

  it('allows only the configured number of concurrent free requests per user and month', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => reserve(db)));
    expect(results.filter((result) => result.allowed)).toHaveLength(2);
    expect(results.filter((result) => !result.allowed)).toHaveLength(6);
    expect(results.at(-1)).toEqual({ allowed: false, used: 2, limit: 2 });

    const persisted = await db.query<{ ai_parses_used: number; ai_parses_limit: number }>(
      'SELECT ai_parses_used, ai_parses_limit FROM public.usage_tracking WHERE user_id = $1',
      [user1]
    );
    expect(persisted.rows).toEqual([{ ai_parses_used: 2, ai_parses_limit: 2 }]);
    expect(await reserve(db, user2)).toEqual({ allowed: true, used: 1, limit: 2 });
  });

  it('uses the latest configured free limit for existing counters and never decrements them', async () => {
    expect(await reserve(db)).toEqual({ allowed: true, used: 1, limit: 2 });
    await db.exec(`UPDATE public.app_settings SET value = '1' WHERE key = 'free_ai_parses_limit'`);
    expect(await reserve(db)).toEqual({ allowed: false, used: 1, limit: 1 });
    await db.exec(`UPDATE public.app_settings SET value = '3' WHERE key = 'free_ai_parses_limit'`);
    expect(await reserve(db)).toEqual({ allowed: true, used: 2, limit: 3 });
  });

  it('falls back to the existing free-plan defaults when settings are missing', async () => {
    await db.exec('DELETE FROM public.app_settings');
    expect(await reserve(db)).toEqual({ allowed: true, used: 1, limit: 15 });
    const result = await db.query<{ transactions_limit: number }>(
      'SELECT transactions_limit FROM public.usage_tracking WHERE user_id = $1',
      [user1]
    );
    expect(result.rows).toEqual([{ transactions_limit: 50 }]);
  });

  it('allows an active pro subscription without a request-count limit', async () => {
    await db.query(
      `INSERT INTO public.subscriptions (user_id, plan, status) VALUES ($1, 'pro', 'active')`,
      [user1]
    );
    const results = await Promise.all(Array.from({ length: 8 }, () => reserve(db)));
    expect(results.every((result) => result.allowed && result.limit === -1)).toBe(true);
    expect(results.at(-1)?.used).toBe(8);
    await db.exec(`UPDATE public.subscriptions SET status = 'canceled' WHERE user_id = '${user1}'`);
    expect(await reserve(db)).toEqual({ allowed: false, used: 8, limit: 2 });
  });

  it('allows only service_role to execute the owner-scoped reservation function', async () => {
    await db.exec('SET ROLE authenticated');
    await expect(reserve(db)).rejects.toThrow(/permission denied/);
    await db.exec('RESET ROLE');
    await db.exec('SET ROLE anon');
    await expect(reserve(db)).rejects.toThrow(/permission denied/);
    await db.exec('RESET ROLE');
    await db.exec('SET ROLE service_role');
    expect(await reserve(db)).toEqual({ allowed: true, used: 1, limit: 2 });
  });

  it('keeps browser transaction-count writes but blocks direct AI-counter resets', async () => {
    await db.exec('SET ROLE authenticated');
    await expect(
      db.query(
        `INSERT INTO public.usage_tracking (user_id, month, ai_parses_used)
         VALUES ($1, '2099-01', 9)`,
        [user1]
      )
    ).rejects.toThrow(/AI parse counter/);
    await db.query(
      `INSERT INTO public.usage_tracking (user_id, month, ai_parses_used, transactions_count)
       VALUES ($1, '2099-01', 0, 1)`,
      [user1]
    );
    await db.query(
      `UPDATE public.usage_tracking SET transactions_count = 2, updated_at = now()
       WHERE user_id = $1 AND month = '2099-01'`,
      [user1]
    );
    const visible = await db.query<{ transactions_count: number }>(
      `SELECT transactions_count FROM public.usage_tracking WHERE user_id = $1`,
      [user1]
    );
    expect(visible.rows).toEqual([{ transactions_count: 2 }]);
    await expect(
      db.query(`UPDATE public.usage_tracking SET ai_parses_used = 0 WHERE user_id = $1`, [user1])
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.query(`DELETE FROM public.usage_tracking WHERE user_id = $1`, [user1])
    ).rejects.toThrow(/permission denied/);
  });

  it('keeps subscription reads but prevents a client from granting itself unlimited pro', async () => {
    await db.query(
      `INSERT INTO public.subscriptions (user_id, plan, status) VALUES ($1, 'free', 'active')`,
      [user1]
    );
    await db.exec('SET ROLE authenticated');
    const visible = await db.query<{ plan: string }>(
      'SELECT plan FROM public.subscriptions WHERE user_id = $1',
      [user1]
    );
    expect(visible.rows).toEqual([{ plan: 'free' }]);
    await expect(
      db.query(`UPDATE public.subscriptions SET plan = 'pro' WHERE user_id = $1`, [user1])
    ).rejects.toThrow(/permission denied/);
    await db.exec('RESET ROLE');
    await db.exec('SET ROLE service_role');
    await db.query(`UPDATE public.subscriptions SET plan = 'pro' WHERE user_id = $1`, [user1]);
    expect(await reserve(db)).toEqual({ allowed: true, used: 1, limit: -1 });
    await db.query(
      `INSERT INTO public.subscriptions (user_id, plan, status) VALUES ($1, 'free', 'active')`,
      [user2]
    );
  });

  it('removes table-wide and DDL grants that bypass row security', async () => {
    await db.exec('SET ROLE authenticated');
    for (const table of ['usage_tracking', 'subscriptions']) {
      const result = await db.query<{ truncate: boolean; references: boolean; trigger: boolean }>(
        `SELECT has_table_privilege('public.${table}', 'TRUNCATE') AS truncate,
                has_table_privilege('public.${table}', 'REFERENCES') AS references,
                has_table_privilege('public.${table}', 'TRIGGER') AS trigger`
      );
      expect(result.rows).toEqual([{ truncate: false, references: false, trigger: false }]);
      await expect(db.exec(`TRUNCATE public.${table}`)).rejects.toThrow(/permission denied/);
      await db.exec(`GRANT TRUNCATE ON public.${table} TO anon`);
      const delegated = await db.query<{ can_truncate: boolean }>(
        `SELECT has_table_privilege('anon', 'public.${table}', 'TRUNCATE') AS can_truncate`
      );
      expect(delegated.rows).toEqual([{ can_truncate: false }]);
    }
  });
});
