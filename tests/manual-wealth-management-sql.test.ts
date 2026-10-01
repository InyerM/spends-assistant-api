import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const migrationPath = join(
  process.cwd(),
  'supabase/migrations/20261001000020_manage_manual_wealth.sql'
);
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const position = '10000000-0000-4000-8000-000000000001';
const loan = '20000000-0000-4000-8000-000000000001';

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE TABLE investment_positions (
      id uuid PRIMARY KEY, user_id uuid NOT NULL, symbol text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE investment_trades (id uuid PRIMARY KEY, position_id uuid NOT NULL);
    CREATE TABLE investment_valuations (id uuid PRIMARY KEY, position_id uuid NOT NULL);
    CREATE TABLE manual_loans (
      id uuid PRIMARY KEY, user_id uuid NOT NULL, label text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE manual_loan_events (id uuid PRIMARY KEY, loan_id uuid NOT NULL);
    INSERT INTO investment_positions(id, user_id, symbol) VALUES ('${position}', '${owner}', 'BTC');
    INSERT INTO manual_loans(id, user_id, label) VALUES ('${loan}', '${owner}', 'Lulo credit');
  `);
  await db.exec(readFileSync(migrationPath, 'utf8'));
  return db;
}

async function asUser(db: PGlite, userId: string, sql: string): Promise<unknown[]> {
  await db.exec(`SET request.jwt.claim.sub = '${userId}'; SET ROLE authenticated;`);
  try {
    return (await db.query(sql)).rows;
  } finally {
    await db.exec('RESET ROLE;');
  }
}

describe('manual wealth record management', () => {
  it('edits labels and archives while keeping an owner-scoped history', async () => {
    const db = await database();
    try {
      await asUser(
        db,
        owner,
        `SELECT manage_manual_wealth_record('investment', '${position}', 'rename', 'Bitcoin')`
      );
      await asUser(
        db,
        owner,
        `SELECT manage_manual_wealth_record('investment', '${position}', 'archive', NULL)`
      );
      expect(
        (
          await db.query(
            `SELECT symbol, archived_at IS NOT NULL AS archived FROM investment_positions WHERE id = '${position}'`
          )
        ).rows
      ).toEqual([{ symbol: 'Bitcoin', archived: true }]);
      await asUser(
        db,
        owner,
        `SELECT manage_manual_wealth_record('investment', '${position}', 'restore', NULL)`
      );
      expect(
        (await db.query(`SELECT archived_at FROM investment_positions WHERE id = '${position}'`))
          .rows
      ).toEqual([{ archived_at: null }]);
      await expect(
        asUser(
          db,
          other,
          `SELECT manage_manual_wealth_record('loan', '${loan}', 'rename', 'Other')`
        )
      ).rejects.toThrow(/not found/i);
      expect((await db.query(`SELECT label FROM manual_loans WHERE id = '${loan}'`)).rows).toEqual([
        { label: 'Lulo credit' }
      ]);
    } finally {
      await db.close();
    }
  });

  it('removes only records without events and refuses to erase their history', async () => {
    const db = await database();
    try {
      await db.exec(`INSERT INTO investment_trades VALUES (gen_random_uuid(), '${position}');`);
      await expect(
        asUser(
          db,
          owner,
          `SELECT manage_manual_wealth_record('investment', '${position}', 'delete_empty', NULL)`
        )
      ).rejects.toThrow(/record has events/i);
      await asUser(
        db,
        owner,
        `SELECT manage_manual_wealth_record('loan', '${loan}', 'delete_empty', NULL)`
      );
      expect(
        (await db.query(`SELECT count(*)::int AS count FROM manual_loans WHERE id = '${loan}'`))
          .rows
      ).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });
});
