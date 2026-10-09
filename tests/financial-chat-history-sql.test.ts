import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, it, expect } from 'vitest';
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
describe('financial chat history isolation', () => {
  it('allows only owner reads/deletes, prevents client writes and cascades account deletion', async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
        CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
          SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        GRANT USAGE ON SCHEMA auth TO authenticated;
        INSERT INTO auth.users VALUES ('${owner}'), ('${other}');`);
      await db.exec(
        readFileSync(
          new URL(
            '../supabase/migrations/20261008000023_financial_chat_history.sql',
            import.meta.url
          ),
          'utf8'
        )
      );
      await db.exec(`INSERT INTO financial_chat_history(user_id,month,question,answer)
        VALUES ('${owner}','2026-10','Spending?','Recorded entry'), ('${other}','2026-10','Income?','Recorded income');
        SET request.jwt.claim.sub = '${owner}'; SET ROLE authenticated;`);
      expect((await db.query('SELECT question FROM financial_chat_history')).rows).toEqual([
        { question: 'Spending?' }
      ]);
      expect(
        (
          await db.query(
            `DELETE FROM financial_chat_history WHERE user_id = '${other}' RETURNING id`
          )
        ).rows
      ).toHaveLength(0);
      await expect(
        db.exec(`INSERT INTO financial_chat_history(user_id,month,question,answer)
        VALUES ('${owner}','2026-10','Fake','Fake')`)
      ).rejects.toThrow();
      await expect(
        db.exec(`UPDATE financial_chat_history SET answer = 'Changed'`)
      ).rejects.toThrow();
      expect((await db.query('DELETE FROM financial_chat_history RETURNING id')).rows).toHaveLength(
        1
      );
      await db.exec(`RESET ROLE; DELETE FROM auth.users WHERE id = '${other}'`);
      expect((await db.query('SELECT * FROM financial_chat_history')).rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  });
});
