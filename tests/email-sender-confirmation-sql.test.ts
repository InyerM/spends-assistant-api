import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../supabase/migrations/20261009000037_email_sender_confirmations.sql', import.meta.url),
  'utf8'
);
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const inbox = '33333333-3333-4333-8333-333333333333';
const foreignInbox = '44444444-4444-4444-8444-444444444444';
async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE TABLE public.shortcut_inbox_items(id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id), source text NOT NULL, raw_text text NOT NULL, status text NOT NULL DEFAULT 'pending');
    INSERT INTO auth.users VALUES ('${owner}'),('${other}');
    INSERT INTO public.shortcut_inbox_items(id,user_id,source,raw_text) VALUES
      ('${inbox}','${owner}','forwarded_email',E'From (unverified): Notices@bank.example\\n\\nSynthetic bank alert'),
      ('${foreignInbox}','${other}','forwarded_email',E'From (unverified): Notices@bank.example\\n\\nSynthetic bank alert');`);
  await db.exec(migration);
  await db.exec(
    `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${owner}',false);`
  );
  return db;
}

describe('owner-confirmed email sender association', () => {
  it('persists an exact normalized sender and allows the owner to correct its bank', async () => {
    const db = await database();
    try {
      await db.query('SELECT public.confirm_email_sender($1,$2)', [inbox, 'Bancolombia']);
      await db.query('SELECT public.confirm_email_sender($1,$2)', [inbox, 'Lulo Bank']);
      const result = await db.query<{ sender_address: string; bank_name: string }>(
        'SELECT sender_address,bank_name FROM public.email_sender_confirmations'
      );
      expect(result.rows).toEqual([
        { sender_address: 'notices@bank.example', bank_name: 'Lulo Bank' }
      ]);
      await db.exec('RESET ROLE');
      expect(
        (
          await db.query<{ status: string }>(
            'SELECT status FROM public.shortcut_inbox_items WHERE id=$1',
            [inbox]
          )
        ).rows[0].status
      ).toBe('pending');
    } finally {
      await db.close();
    }
  });
  it('rejects another owner inbox and hides associations from another owner', async () => {
    const db = await database();
    try {
      await expect(
        db.query('SELECT public.confirm_email_sender($1,$2)', [foreignInbox, 'Bancolombia'])
      ).rejects.toThrow();
      await db.query('SELECT public.confirm_email_sender($1,$2)', [inbox, 'Bancolombia']);
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [other]);
      expect((await db.query('SELECT * FROM public.email_sender_confirmations')).rows).toEqual([]);
      await expect(
        db.query(
          "INSERT INTO public.email_sender_confirmations(user_id,sender_address,bank_name) VALUES ($1,'other@bank.example','Bancolombia')",
          [other]
        )
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});

it('rejects unauthenticated confirmation and invalid bank input without creating an association', async () => {
  const db = await database();
  try {
    await expect(
      db.query('SELECT public.confirm_email_sender($1,$2)', [inbox, '<script>'])
    ).rejects.toThrow();
    await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
    await expect(
      db.query('SELECT public.confirm_email_sender($1,$2)', [inbox, 'Bancolombia'])
    ).rejects.toThrow();
    await db.exec('RESET ROLE');
    expect((await db.query('SELECT * FROM public.email_sender_confirmations')).rows).toEqual([]);
  } finally {
    await db.close();
  }
});
