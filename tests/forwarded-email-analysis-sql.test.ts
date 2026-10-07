import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const inbox = '10000000-0000-4000-8000-000000000001';
const smsInbox = '10000000-0000-4000-8000-000000000002';
const migration = (name: string): string =>
  readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8');

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE ROLE anon;
    CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
    INSERT INTO auth.users VALUES ('${owner}'), ('${other}');
  `);
  await db.exec(migration('20260929000030_shortcut_inbox.sql'));
  await db.exec(`ALTER TABLE public.shortcut_inbox_items
    ADD CONSTRAINT shortcut_inbox_items_id_user_unique UNIQUE (id, user_id);`);
  await db.exec(`
    INSERT INTO public.shortcut_inbox_items(id,user_id,source,external_id,received_at,raw_text,idempotency_key)
      VALUES ('${inbox}','${owner}','forwarded_email','message-1',now(),
      'Synthetic purchase',repeat('a',64));
  `);
  await db.exec(migration('20261006000010_forwarded_email_analysis.sql'));
  await db.exec(migration('20261006000030_forwarded_email_review_copy.sql'));
  await db.exec(migration('20261006000050_forwarded_email_review_provenance.sql'));
  return db;
}

async function asUser<T>(db: PGlite, userId: string, sql: string): Promise<T[]> {
  await db.exec(`SET request.jwt.claim.sub = '${userId}'; SET ROLE authenticated;`);
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec('RESET ROLE; RESET request.jwt.claim.sub;');
  }
}

describe('persisted forwarded email analysis', () => {
  it('lets only the owner enrich a pending proposal while keeping financial state untouched', async () => {
    const db = await database();
    try {
      await asUser(
        db,
        owner,
        `INSERT INTO public.forwarded_email_analyses
        (inbox_item_id,user_id,status) VALUES ('${inbox}','${owner}','needs_review')`
      );
      const update = `UPDATE public.forwarded_email_analyses SET analysis_version=2,
        suggested_type='expense', description='Lunch at Krokan', notes='Owner confirmed lunch.'
        WHERE inbox_item_id='${inbox}' RETURNING description,notes`;
      expect(await asUser(db, other, update)).toEqual([]);
      expect(await asUser(db, owner, update)).toEqual([
        { description: 'Lunch at Krokan', notes: 'Owner confirmed lunch.' }
      ]);
      await asUser(
        db,
        owner,
        `UPDATE public.forwarded_email_analyses
        SET category_id='30000000-0000-4000-8000-000000000001',
          category_source='review_context' WHERE inbox_item_id='${inbox}'`
      );
      expect(
        await asUser(db, owner, `SELECT category_source FROM public.forwarded_email_analyses`)
      ).toEqual([{ category_source: 'review_context' }]);
      await expect(
        asUser(
          db,
          owner,
          `UPDATE public.forwarded_email_analyses
        SET status='parsed' WHERE inbox_item_id='${inbox}'`
        )
      ).rejects.toThrow();
      await db.exec(
        `UPDATE public.shortcut_inbox_items SET status='dismissed' WHERE id='${inbox}'`
      );
      expect(await asUser(db, owner, update)).toEqual([]);
    } finally {
      await db.close();
    }
  });
  it('stores one owner-scoped proposal without posting a transaction', async () => {
    const db = await database();
    try {
      const insert = `INSERT INTO public.forwarded_email_analyses
        (inbox_item_id,user_id,status,merchant,amount,bank_event_at,card_last_four)
        VALUES ('${inbox}','${owner}','parsed','CEA PRACTICAR DEL EJE',1550000,
          '2026-10-06T20:42:00Z','8456')
        ON CONFLICT (inbox_item_id) DO NOTHING RETURNING inbox_item_id`;
      expect(await asUser(db, owner, insert)).toHaveLength(1);
      expect(await asUser(db, owner, insert)).toHaveLength(0);
      expect(
        await asUser(db, owner, 'SELECT merchant FROM public.forwarded_email_analyses')
      ).toEqual([{ merchant: 'CEA PRACTICAR DEL EJE' }]);
      expect(
        await asUser(db, other, 'SELECT merchant FROM public.forwarded_email_analyses')
      ).toEqual([]);
      expect((await db.query('SELECT status FROM public.shortcut_inbox_items')).rows).toEqual([
        { status: 'pending' }
      ]);
    } finally {
      await db.close();
    }
  });

  it('rejects a foreign owner and erases the proposal with its inbox item', async () => {
    const db = await database();
    try {
      await expect(
        asUser(
          db,
          other,
          `INSERT INTO public.forwarded_email_analyses
        (inbox_item_id,user_id,status) VALUES ('${inbox}','${other}','needs_review')`
        )
      ).rejects.toThrow();
      await db.exec(`INSERT INTO public.shortcut_inbox_items
        (id,user_id,source,received_at,raw_text,idempotency_key)
        VALUES ('${smsInbox}','${owner}','sms-shortcut',now(),
          'Synthetic SMS',repeat('b',64))`);
      await expect(
        asUser(
          db,
          owner,
          `INSERT INTO public.forwarded_email_analyses
        (inbox_item_id,user_id,status) VALUES ('${smsInbox}','${owner}','needs_review')`
        )
      ).rejects.toThrow();
      await asUser(
        db,
        owner,
        `INSERT INTO public.forwarded_email_analyses
        (inbox_item_id,user_id,status) VALUES ('${inbox}','${owner}','needs_review')`
      );
      await expect(
        asUser(
          db,
          owner,
          `UPDATE public.forwarded_email_analyses
        SET status='parsed' WHERE inbox_item_id='${inbox}'`
        )
      ).rejects.toThrow();
      await db.exec(`DELETE FROM public.shortcut_inbox_items WHERE id='${inbox}'`);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.forwarded_email_analyses')).rows
      ).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });
});
