import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../supabase/migrations/20260929000040_manual_investments.sql', import.meta.url),
  'utf8'
);
const owner = '11111111-1111-4111-8111-111111111111';
const requestId = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE ROLE anon;
    CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
    INSERT INTO auth.users VALUES ('${owner}');
  `);
  await db.exec(migration);
  await db.exec(`SET request.jwt.claim.sub = '${owner}'; SET ROLE authenticated;`);
  return db;
}

const evidence = {
  kind: 'manual_review',
  reference: 'Synthetic trade statement',
  observed_on: '2026-09-29'
};

async function confirm(db: PGlite, number: number, event: Record<string, unknown>) {
  const result = await db.query<{ confirm_investment_event: Record<string, unknown> }>(
    'SELECT public.confirm_investment_event($1::uuid,true,$2::jsonb)',
    [requestId(number), JSON.stringify({ ...event, evidence })]
  );
  return result.rows[0].confirm_investment_event;
}

async function position(db: PGlite): Promise<string> {
  const result = await confirm(db, 1, {
    action: 'create_position',
    provider: 'binance',
    symbol: 'BTC',
    quote_currency: 'USDT',
    quantity_scale: 0,
    money_scale: 0
  });
  return result.position_id as string;
}

const trade = (
  action: 'buy' | 'sell',
  positionId: string,
  occurredOn: string,
  quantityAtoms: string,
  grossMinor: string
) => ({
  action,
  position_id: positionId,
  occurred_on: occurredOn,
  quantity_atoms: quantityAtoms,
  gross_minor: grossMinor,
  fee_minor: '0'
});

describe('investment journal entry order', () => {
  it('rejects a sale backdated before the latest buy without consuming future shares', async () => {
    const db = await database();
    try {
      const id = await position(db);
      await confirm(db, 2, trade('buy', id, '2026-09-29', '10', '1000'));
      await expect(confirm(db, 3, trade('sell', id, '2026-09-28', '5', '700'))).rejects.toThrow(
        /chronological order/i
      );
      expect(
        (
          await db.query(`SELECT quantity_atoms, cost_basis_minor, realized_return_minor
        FROM public.investment_positions WHERE id = '${id}'`)
        ).rows
      ).toEqual([{ quantity_atoms: '10', cost_basis_minor: '1000', realized_return_minor: '0' }]);
      expect(
        (
          await db.query(`SELECT count(*)::integer AS count FROM public.investment_trades
        WHERE position_id = '${id}'`)
        ).rows
      ).toEqual([{ count: 1 }]);
    } finally {
      await db.close();
    }
  });

  it('rejects a backdated buy after a sale and replays an earlier request unchanged', async () => {
    const db = await database();
    try {
      const id = await position(db);
      const firstBuy = trade('buy', id, '2026-09-27', '10', '1000');
      const first = await confirm(db, 2, firstBuy);
      await confirm(db, 3, trade('sell', id, '2026-09-29', '5', '700'));
      await expect(confirm(db, 4, trade('buy', id, '2026-09-28', '5', '800'))).rejects.toThrow(
        /chronological order/i
      );
      expect(await confirm(db, 2, firstBuy)).toMatchObject({ ...first, replayed: true });
      expect(
        (
          await db.query(`SELECT quantity_atoms, cost_basis_minor, realized_return_minor
        FROM public.investment_positions WHERE id = '${id}'`)
        ).rows
      ).toEqual([{ quantity_atoms: '5', cost_basis_minor: '500', realized_return_minor: '200' }]);
    } finally {
      await db.close();
    }
  });

  it('allows reviewed trades on the latest recorded date in confirmation order', async () => {
    const db = await database();
    try {
      const id = await position(db);
      await confirm(db, 2, trade('buy', id, '2026-09-29', '10', '1000'));
      await confirm(db, 3, trade('sell', id, '2026-09-29', '5', '700'));
      expect(
        (
          await db.query(`SELECT quantity_atoms, cost_basis_minor, realized_return_minor
        FROM public.investment_positions WHERE id = '${id}'`)
        ).rows
      ).toEqual([{ quantity_atoms: '5', cost_basis_minor: '500', realized_return_minor: '200' }]);
    } finally {
      await db.close();
    }
  });
});
