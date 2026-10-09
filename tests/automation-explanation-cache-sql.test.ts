import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
describe('automation explanation owner cache', () => {
  it('allows owner reads, blocks cross-owner reads and client writes, cascades user deletion', async () => {
    const db = new PGlite();
    const owner = '11111111-1111-4111-8111-111111111111';
    const other = '22222222-2222-4222-8222-222222222222';
    try {
      await db.exec(
        `CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; GRANT USAGE ON SCHEMA auth TO authenticated; INSERT INTO auth.users VALUES ('${owner}'),('${other}');`
      );
      await db.exec(
        readFileSync(
          new URL(
            '../supabase/migrations/20261009000035_automation_rule_explanations.sql',
            import.meta.url
          ),
          'utf8'
        )
      );
      await db.exec(
        `INSERT INTO automation_rule_explanations(user_id,fingerprint,locale,explanation) VALUES ('${owner}','${'a'.repeat(64)}','es','Only owner can read'); SET ROLE authenticated; SET request.jwt.claim.sub='${owner}';`
      );
      expect((await db.query('SELECT explanation FROM automation_rule_explanations')).rows).toEqual(
        [{ explanation: 'Only owner can read' }]
      );
      await db.exec(`SET request.jwt.claim.sub='${other}';`);
      expect((await db.query('SELECT * FROM automation_rule_explanations')).rows).toEqual([]);
      await expect(
        db.exec(
          `INSERT INTO automation_rule_explanations(user_id,fingerprint,locale,explanation) VALUES ('${other}','${'b'.repeat(64)}','es','Forged');`
        )
      ).rejects.toThrow('permission denied');
      await db.exec(`RESET ROLE; DELETE FROM auth.users WHERE id='${owner}';`);
      expect((await db.query('SELECT * FROM automation_rule_explanations')).rows).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
