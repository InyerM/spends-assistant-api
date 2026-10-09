import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

it('keeps attachment provenance immutable and owner-bound while account deletion cascades', async () => {
  const db = new PGlite();
  const owner = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  const inbox = '33333333-3333-4333-8333-333333333333';
  try {
    await db.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
      CREATE TABLE public.shortcut_inbox_items(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users ON DELETE CASCADE, UNIQUE(id,user_id));
      CREATE TABLE public.documents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES auth.users ON DELETE CASCADE);
      INSERT INTO auth.users VALUES('${owner}'),('${other}');
      INSERT INTO public.shortcut_inbox_items VALUES('${inbox}','${owner}');`);
    await db.exec(
      readFileSync(
        new URL('../supabase/migrations/20261008000026_email_pdf_provenance.sql', import.meta.url),
        'utf8'
      )
    );
    await db.exec(`SET request.jwt.claim.role='authenticated';`);
    await expect(
      db.exec(
        `INSERT INTO documents(user_id,source_inbox_item_id,email_attachment_key) VALUES('${owner}','${inbox}','${'a'.repeat(64)}')`
      )
    ).rejects.toThrow('Server-owned attachment provenance');
    await db.exec(`SET request.jwt.claim.role='service_role';`);
    await expect(
      db.exec(
        `INSERT INTO documents(user_id,source_inbox_item_id,email_attachment_key) VALUES('${other}','${inbox}','${'a'.repeat(64)}')`
      )
    ).rejects.toThrow();
    await db.exec(
      `INSERT INTO documents(user_id,source_inbox_item_id,email_attachment_key) VALUES('${owner}','${inbox}','${'a'.repeat(64)}')`
    );
    await expect(
      db.exec(
        `INSERT INTO documents(user_id,source_inbox_item_id,email_attachment_key) VALUES('${owner}','${inbox}','${'a'.repeat(64)}')`
      )
    ).rejects.toThrow();
    await expect(
      db.exec(`UPDATE documents SET email_attachment_key='${'b'.repeat(64)}'`)
    ).rejects.toThrow('Attachment provenance is immutable');
    await db.exec(`DELETE FROM auth.users WHERE id='${owner}'`);
    expect((await db.query('SELECT * FROM documents')).rows).toHaveLength(0);
  } finally {
    await db.close();
  }
});
