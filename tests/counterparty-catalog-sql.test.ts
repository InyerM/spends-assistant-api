import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

it('scans every confirmed transaction idempotently without changing financial rows', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      CREATE FUNCTION public.has_accepted_required_terms() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE TABLE public.categories(id uuid PRIMARY KEY,user_id uuid,name text,translations jsonb);
      CREATE TABLE public.transactions(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users(id),type text,raw_text text,description text,notes text,parsed_data jsonb,date date,amount numeric,currency text,category_id uuid,transfer_id uuid,transfer_to_account_id uuid,deleted_at timestamptz, UNIQUE(id,user_id));
      INSERT INTO auth.users VALUES('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');
      SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);`);
    await db.exec(
      readFileSync('supabase/migrations/20261009000039_counterparty_catalog.sql', 'utf8')
    );
    await db.exec(`INSERT INTO transactions(id,user_id,type,raw_text,description,date,amount,currency) VALUES
      ('00000000-0000-4000-8000-000000000011',auth.uid(),'expense','Transferiste $30.000 desde tu cuenta *1234 a la cuenta *0001112233','Lunch','2026-10-01',30000,'COP'),
      ('00000000-0000-4000-8000-000000000012',auth.uid(),'expense','Transferiste $30.000 a la cuenta *0001112233','Lunch','2026-10-02',30,'USD'),
      ('00000000-0000-4000-8000-000000000013',auth.uid(),'expense','Transferiste a la cuenta *1234','Unknown','2026-10-02',30,'COP');`);
    expect(
      (
        await db.query(
          "SELECT public.counterparty_evidence('Transferiste a Nequi 3001112233') evidence"
        )
      ).rows[0]
    ).toMatchObject({ evidence: { status: 'found', kind: 'nequi', value: '3001112233' } });
    expect(
      (
        await db.query(
          "SELECT public.counterparty_evidence('Pagaste a la llave 0001112233') evidence"
        )
      ).rows[0]
    ).toMatchObject({ evidence: { status: 'found', kind: 'payment_key', value: '0001112233' } });
    expect(
      (
        await db.query(
          "SELECT public.counterparty_evidence('Transferiste a la cuenta *0001112233 y a la cuenta *0004445566') evidence"
        )
      ).rows[0]
    ).toMatchObject({ evidence: { status: 'ambiguous' } });
    expect(
      (
        await db.query(
          "SELECT public.counterparty_evidence('Realizaste una compra en ACME SHOP por $45,000') evidence"
        )
      ).rows[0]
    ).toMatchObject({ evidence: { status: 'found', kind: 'merchant', value: 'acme shop' } });
    expect(
      (
        await db.query(
          "SELECT public.counterparty_evidence('Recibiste una transferencia de ACME S.A.S. por $45,000 en tu cuenta *1234 conectada a la llave 3001112233') evidence"
        )
      ).rows[0]
    ).toMatchObject({ evidence: { status: 'found', kind: 'merchant', value: 'acme s.a.s.' } });
    const before = (await db.query('SELECT * FROM transactions ORDER BY id')).rows;
    await db.query('SELECT public.scan_counterparty_catalog(null,200)');
    await db.query('SELECT public.scan_counterparty_catalog(null,200)');
    expect((await db.query('SELECT * FROM transactions ORDER BY id')).rows).toEqual(before);
    expect((await db.query('SELECT identity_value FROM counterparties')).rows).toEqual([
      { identity_value: '0001112233' }
    ]);
    expect((await db.query('SELECT count(*)::int n FROM transaction_counterparties')).rows).toEqual(
      [{ n: 2 }]
    );
    expect((await db.query('SELECT count(*)::int n FROM counterparty_scan_results')).rows).toEqual([
      { n: 3 }
    ]);
    const contact = (await db.query<{ id: string }>('SELECT id FROM counterparties')).rows[0].id;
    const detail = (
      await db.query<{ detail: { totals: Array<{ currency: string; expenses: number }> } }>(
        'SELECT public.counterparty_detail($1) detail',
        [contact]
      )
    ).rows[0].detail;
    expect(detail.totals).toEqual(
      expect.arrayContaining([
        { currency: 'COP', count: 1, expenses: 30000, income: null },
        { currency: 'USD', count: 1, expenses: 30, income: null }
      ])
    );
    await db.query('SELECT public.rename_counterparty($1,$2)', [contact, 'Lunch provider']);
    await db.query('SELECT public.scan_counterparty_catalog(null,200)');
    expect((await db.query('SELECT custom_name FROM counterparties')).rows[0]).toEqual({
      custom_name: 'Lunch provider'
    });
    await db.exec(readFileSync('supabase/migrations/20261009000052_counterparty_sort.sql', 'utf8'));
    await db.exec(
      `INSERT INTO transactions(id,user_id,type,raw_text,description,date,amount,currency) VALUES ('00000000-0000-4000-8000-000000000014',auth.uid(),'expense','Realizaste una compra en ACME SHOP por $45,000','Shop','2026-10-09',45000,'COP');`
    );
    await db.query('SELECT public.scan_counterparty_catalog(null,200)');
    const most = (
      await db.query<{ result: { items: Array<{ name: string; movement_count: number }> } }>(
        "SELECT list_counterparties_sorted('',0,1,'most_transactions') result"
      )
    ).rows[0].result;
    expect(most.items.map((item) => item.movement_count)).toEqual([2]);
    const next = (
      await db.query<{ result: { items: Array<{ movement_count: number }> } }>(
        "SELECT list_counterparties_sorted('',1,1,'most_transactions') result"
      )
    ).rows[0].result;
    expect(next.items.map((item) => item.movement_count)).toEqual([1]);
    const fewest = (
      await db.query<{ result: { items: Array<{ movement_count: number }> } }>(
        "SELECT list_counterparties_sorted('',0,50,'fewest_transactions') result"
      )
    ).rows[0].result;
    expect(fewest.items.map((item) => item.movement_count)).toEqual([1, 2]);
    await db.exec(
      "UPDATE transactions SET deleted_at=now() WHERE id='00000000-0000-4000-8000-000000000012'"
    );
    const changed = (
      await db.query<{
        result: { items: Array<{ movement_count: number; last_activity: string }> };
      }>("SELECT list_counterparties_sorted('',0,50,'most_transactions') result")
    ).rows[0].result;
    expect(changed.items.map((item) => item.movement_count)).toEqual([1, 1]);
    expect(changed.items[0].last_activity).toBe('2026-10-09');
    await db.exec(
      `SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false); SET ROLE authenticated;`
    );
    expect((await db.query('SELECT * FROM counterparties')).rows).toEqual([]);
    await expect(
      db.query("SELECT public.rename_counterparty($1,'Other owner')", [contact])
    ).rejects.toThrow();
  } finally {
    await db.close();
  }
});
