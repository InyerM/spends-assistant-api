import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const owner = '00000000-0000-4000-8000-000000000001';
const stranger = '00000000-0000-4000-8000-000000000002';
const address = `f-${'a'.repeat(64)}@mail.example.com`;

describe('email forwarding route migration', () => {
  it('exposes only the owner address and prevents user-managed route insertion', async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE ROLE authenticated;
        CREATE ROLE service_role;
        CREATE ROLE anon;
        CREATE SCHEMA auth;
        CREATE TABLE auth.users (id uuid PRIMARY KEY);
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
          SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
        $$;
        INSERT INTO auth.users VALUES ('${owner}'), ('${stranger}');
      `);
      await db.exec(
        readFileSync(
          join(process.cwd(), 'supabase/migrations/20261002000020_email_forwarding_routes.sql'),
          'utf8'
        )
      );
      await db.exec(
        `INSERT INTO email_forwarding_routes(user_id,address) VALUES ('${owner}','${address}')`
      );
      await db.exec(`SET request.jwt.claim.sub = '${owner}'; SET ROLE authenticated;`);
      expect((await db.query('SELECT address FROM email_forwarding_routes')).rows).toEqual([
        { address }
      ]);
      await db.exec(
        `RESET ROLE; SET request.jwt.claim.sub = '${stranger}'; SET ROLE authenticated;`
      );
      expect((await db.query('SELECT address FROM email_forwarding_routes')).rows).toEqual([]);
      await expect(
        db.query(
          `INSERT INTO email_forwarding_routes(user_id,address) VALUES ('${stranger}','f-${'b'.repeat(64)}@mail.example.com')`
        )
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});
