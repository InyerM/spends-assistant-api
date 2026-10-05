import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const inbox = '10000000-0000-4000-8000-000000000001';
const mismatchInbox = '10000000-0000-4000-8000-000000000002';
const account = '20000000-0000-4000-8000-000000000001';
const category = '30000000-0000-4000-8000-000000000001';
const migration = (name: string) =>
  readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8');

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE ROLE anon;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
    CREATE TABLE public.accounts(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      balance numeric(15,2), type text, institution text, last_four text, currency text,
      is_active boolean DEFAULT true, deleted_at timestamptz);
    CREATE TABLE public.categories(id uuid PRIMARY KEY, user_id uuid NOT NULL,
      type text NOT NULL, is_active boolean DEFAULT true, deleted_at timestamptz);
    CREATE TABLE public.transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL, amount numeric(15,2) NOT NULL, date date NOT NULL,
      time time NOT NULL, description text NOT NULL, account_id uuid NOT NULL REFERENCES public.accounts(id),
      category_id uuid, type text NOT NULL, source text NOT NULL, raw_text text,
      parsed_data jsonb, deleted_at timestamptz, UNIQUE(id,user_id));
    CREATE TABLE public.usage_tracking(user_id uuid NOT NULL, month text NOT NULL,
      transactions_count integer NOT NULL DEFAULT 0, updated_at timestamptz DEFAULT now(),
      PRIMARY KEY(user_id,month));
    CREATE TABLE public.subscriptions(user_id uuid PRIMARY KEY, plan text NOT NULL,
      status text NOT NULL DEFAULT 'active');
    CREATE TABLE public.app_settings(key text PRIMARY KEY, value jsonb NOT NULL);
    INSERT INTO auth.users VALUES ('${owner}'), ('${other}');
    INSERT INTO public.accounts VALUES ('${account}','${owner}',1000000,'credit_card','lulobank','8456','COP',true,NULL);
    INSERT INTO public.categories VALUES ('${category}','${owner}','expense',true,NULL);
    INSERT INTO public.subscriptions VALUES ('${owner}','pro');
  `);
  await db.exec(migration('20260929000030_shortcut_inbox.sql'));
  await db.exec(migration('20260929000080_shortcut_match_ack.sql'));
  await db.exec(migration('20260929000110_shortcut_create_transaction.sql'));
  await db.exec(migration('20260929000120_shortcut_match_reversal.sql'));
  await db.exec(migration('20260929000180_shortcut_reviewed_event_time.sql'));
  await db.exec(migration('20261002000020_email_forwarding_routes.sql'));
  await db.exec(migration('20261002000030_email_forwarding_subaddresses.sql'));
  await db.exec(migration('20261003000000_email_forwarding_smtp_addresses.sql'));
  await db.exec(migration('20261003000010_email_forwarding_user_confirmation.sql'));
  await db.exec(`
    INSERT INTO public.email_forwarding_routes(user_id,address,confirmation_received_at,user_confirmed_at)
      VALUES ('${owner}','capture+${'a'.repeat(48)}@mail.example.com',now(),now());
    INSERT INTO public.shortcut_inbox_items(id,user_id,source,external_id,received_at,raw_text,idempotency_key)
      VALUES ('${inbox}','${owner}','forwarded_email','mail-1','2026-10-05T18:00:00Z',
        'From (unverified): notificaciones@lulobank.com\n\nCompra realizada\n\nRealizaste una compra en SHEIN.COM por $188,165.52\nOrigen tarjeta de crédito •8456\nFecha 5 de octubre de 2026\nHora 12:24 p.m.',repeat('a',64));
  `);
  await db.exec(migration('20261005000000_verified_forwarded_email_auto_post.sql'));
  return db;
}

function post(user = owner, item = inbox, amount = '188165.52'): string {
  return `SELECT public.auto_post_verified_forwarded_purchase('${user}','${item}',
    '${account}','${category}','${amount}','2026-10-05','12:24:00','8456',
    'Compra en SHEIN.COM','deepseek/test') AS result`;
}

async function asService(db: PGlite, sql: string): Promise<{ status: string; replayed?: boolean }> {
  await db.exec('SET ROLE service_role;');
  try {
    const result = await db.query<{ result: { status: string; replayed?: boolean } }>(sql);
    return result.rows[0].result;
  } finally {
    await db.exec('RESET ROLE;');
  }
}

describe('verified forwarded purchase auto post', () => {
  it('posts once atomically and records a distinct automatic audit decision', async () => {
    const db = await database();
    try {
      expect(await asService(db, post())).toMatchObject({ status: 'created', replayed: false });
      expect(await asService(db, post())).toMatchObject({ status: 'created', replayed: true });
      expect((await db.query('SELECT count(*)::int AS n FROM public.transactions')).rows).toEqual([
        { n: 1 }
      ]);
      expect((await db.query('SELECT balance FROM public.accounts')).rows).toEqual([
        { balance: '811834.48' }
      ]);
      expect(
        (await db.query('SELECT count(*)::int AS n FROM public.forwarded_email_auto_posts')).rows
      ).toEqual([{ n: 1 }]);
      const provenance = await db.query<{
        parsed_data: Record<string, unknown>;
        reviewed_payload: Record<string, unknown>;
      }>(`SELECT t.parsed_data, d.reviewed_payload FROM public.transactions t
        JOIN public.shortcut_inbox_match_decisions d ON d.transaction_id=t.id`);
      expect(provenance.rows[0].parsed_data).toMatchObject({
        email_auto_post: true,
        shortcut_inbox_item_id: inbox
      });
      expect(provenance.rows[0].reviewed_payload).not.toHaveProperty('event_time_confirmed');
      expect(provenance.rows[0].reviewed_payload).toMatchObject({ automated: true });
    } finally {
      await db.close();
    }
  });

  it('holds an existing same-day same-amount transaction without changing balances', async () => {
    const db = await database();
    try {
      await db.exec(`INSERT INTO public.transactions(user_id,amount,date,time,description,account_id,category_id,type,source)
        VALUES ('${owner}',188165.52,'2026-10-05','12:24:00','Existing purchase','${account}','${category}','expense','sms')`);
      expect(await asService(db, post())).toMatchObject({ status: 'review_required' });
      expect((await db.query('SELECT balance FROM public.accounts')).rows).toEqual([
        { balance: '1000000.00' }
      ]);
    } finally {
      await db.close();
    }
  });

  it('refuses unverified routes, other owners, and non-service callers', async () => {
    const db = await database();
    try {
      await db.exec(
        `UPDATE public.email_forwarding_routes SET user_confirmed_at=NULL WHERE user_id='${owner}'`
      );
      await expect(asService(db, post())).rejects.toThrow();
      await db.exec(
        `UPDATE public.email_forwarding_routes SET user_confirmed_at=now() WHERE user_id='${owner}'`
      );
      await expect(asService(db, post(other))).rejects.toThrow();
      await db.exec('SET ROLE authenticated;');
      await expect(db.query(post())).rejects.toThrow();
      await db.exec('RESET ROLE;');
      expect((await db.query('SELECT count(*)::int AS n FROM public.transactions')).rows).toEqual([
        { n: 0 }
      ]);
    } finally {
      await db.close();
    }
  });

  it('rejects a posted amount that differs from the immutable email evidence', async () => {
    const db = await database();
    try {
      await expect(asService(db, post(owner, inbox, '999999.00'))).rejects.toThrow('amount');
      expect((await db.query('SELECT count(*)::int AS n FROM public.transactions')).rows).toEqual([
        { n: 0 }
      ]);
    } finally {
      await db.close();
    }
  });

  it('rejects an account suffix that is absent from the immutable email evidence', async () => {
    const db = await database();
    try {
      await db.exec(`INSERT INTO public.shortcut_inbox_items
        (id,user_id,source,external_id,received_at,raw_text,idempotency_key)
        VALUES ('${mismatchInbox}','${owner}','forwarded_email','mail-2',
          '2026-10-05T18:00:00Z',
          'From (unverified): notificaciones@lulobank.com\n\nCompra realizada\n\nRealizaste una compra en SHEIN.COM por $188,165.52\nOrigen tarjeta de crédito •9999\nFecha 5 de octubre de 2026\nHora 12:24 p.m.',repeat('b',64))`);
      await expect(asService(db, post(owner, mismatchInbox))).rejects.toThrow('evidence');
      expect((await db.query('SELECT count(*)::int AS n FROM public.transactions')).rows).toEqual([
        { n: 0 }
      ]);
    } finally {
      await db.close();
    }
  });

  it('does not recreate an automatically posted transaction after its hard deletion', async () => {
    const db = await database();
    try {
      const created = await asService(db, post());
      expect(created.status).toBe('created');
      await db.exec('DELETE FROM public.transactions');
      expect(await asService(db, post())).toMatchObject({ status: 'review_required' });
      expect((await db.query('SELECT count(*)::int AS n FROM public.transactions')).rows).toEqual([
        { n: 0 }
      ]);
    } finally {
      await db.close();
    }
  });

  it('rejects a non-Lulo card even with the same suffix', async () => {
    const db = await database();
    try {
      await db.exec(`UPDATE public.accounts SET institution='bancolombia' WHERE id='${account}'`);
      await expect(asService(db, post())).rejects.toThrow('account');
      expect((await db.query('SELECT count(*)::int AS n FROM public.transactions')).rows).toEqual([
        { n: 0 }
      ]);
    } finally {
      await db.close();
    }
  });
});
