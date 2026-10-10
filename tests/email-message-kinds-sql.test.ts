import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
it('defaults legacy messages to unclassified and bounds kinds independently of review status', async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "CREATE TABLE shortcut_inbox_items(id uuid PRIMARY KEY,user_id uuid,received_at timestamptz,source text,status text); INSERT INTO shortcut_inbox_items VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',now(),'forwarded_email','created');"
    );
    await db.exec(
      readFileSync('supabase/migrations/20261009000038_email_message_kinds.sql', 'utf8')
    );
    expect(
      (await db.query('SELECT status,message_kind,message_kind_source FROM shortcut_inbox_items'))
        .rows
    ).toEqual([
      { status: 'created', message_kind: 'uncertain', message_kind_source: 'unclassified' }
    ]);
    await expect(
      db.exec("UPDATE shortcut_inbox_items SET message_kind='invalid'")
    ).rejects.toThrow();
    await db.exec(
      "UPDATE shortcut_inbox_items SET message_kind='purchase',message_kind_source='rules'"
    );
    expect((await db.query('SELECT status FROM shortcut_inbox_items')).rows).toEqual([
      { status: 'created' }
    ]);
  } finally {
    await db.close();
  }
});
