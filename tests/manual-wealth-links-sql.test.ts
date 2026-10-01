import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const migrationPath = join(
  process.cwd(),
  'supabase/migrations/20261001000030_manual_wealth_transaction_links.sql'
);
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const tradeId = '10000000-0000-4000-8000-000000000001';
const loanEventId = '20000000-0000-4000-8000-000000000001';
const expenseId = '30000000-0000-4000-8000-000000000001';
const incomeId = '30000000-0000-4000-8000-000000000002';

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE TABLE transactions (
      id uuid PRIMARY KEY, user_id uuid NOT NULL, amount numeric NOT NULL,
      date date NOT NULL, type text NOT NULL, deleted_at timestamptz,
      UNIQUE(id, user_id)
    );
    CREATE TABLE investment_trades (
      id uuid PRIMARY KEY, user_id uuid NOT NULL, kind text NOT NULL,
      occurred_on date NOT NULL
    );
    CREATE TABLE manual_loan_events (
      id uuid PRIMARY KEY, user_id uuid NOT NULL, kind text NOT NULL,
      occurred_on date NOT NULL
    );
    GRANT SELECT, UPDATE ON transactions TO authenticated;
    INSERT INTO auth.users VALUES ('${owner}'), ('${other}');
    INSERT INTO transactions(id,user_id,amount,date,type) VALUES
      ('${expenseId}','${owner}',1200,'2026-09-29','expense'),
      ('${incomeId}','${owner}',1200,'2026-09-29','income');
    INSERT INTO investment_trades VALUES ('${tradeId}','${owner}','buy','2026-09-29');
    INSERT INTO manual_loan_events VALUES ('${loanEventId}','${owner}','payment','2026-09-29');
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

describe('reviewed manual wealth transaction links', () => {
  it('links an owner trade to the right transaction and preserves an audit record', async () => {
    const db = await database();
    try {
      await asUser(
        db,
        owner,
        `SELECT link_manual_wealth_event('investment_trade','${tradeId}','${expenseId}',true)`
      );
      expect(
        (
          await db.query(
            `SELECT source_transaction_id FROM investment_trades WHERE id='${tradeId}'`
          )
        ).rows
      ).toEqual([{ source_transaction_id: expenseId }]);
      expect(
        (await db.query('SELECT event_kind, new_transaction_id FROM manual_wealth_link_audit')).rows
      ).toEqual([{ event_kind: 'investment_trade', new_transaction_id: expenseId }]);
      await expect(
        asUser(db, owner, `UPDATE transactions SET deleted_at=now() WHERE id='${expenseId}'`)
      ).rejects.toThrow(/reviewed wealth link/i);
    } finally {
      await db.close();
    }
  });

  it('rejects another owner and wrong directions before linking a loan payment', async () => {
    const db = await database();
    try {
      await expect(
        asUser(
          db,
          other,
          `SELECT link_manual_wealth_event('loan_event','${loanEventId}','${expenseId}',true)`
        )
      ).rejects.toThrow(/not found/i);
      await expect(
        asUser(
          db,
          owner,
          `SELECT link_manual_wealth_event('loan_event','${loanEventId}','${incomeId}',true)`
        )
      ).rejects.toThrow(/direction/i);
      await asUser(
        db,
        owner,
        `SELECT link_manual_wealth_event('loan_event','${loanEventId}','${expenseId}',true)`
      );
      expect(
        (
          await db.query(
            `SELECT source_transaction_id FROM manual_loan_events WHERE id='${loanEventId}'`
          )
        ).rows
      ).toEqual([{ source_transaction_id: expenseId }]);
    } finally {
      await db.close();
    }
  });
});
