import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const owner = '00000000-0000-4000-8000-000000000001';
const stranger = '00000000-0000-4000-8000-000000000002';
const legacyAddress = `f-${'a'.repeat(64)}@mail.example.com`;
const address = `capture+${'b'.repeat(64)}@mail.example.com`;

describe('email forwarding route migration', () => {
  it('stores a user confirmation only after Gmail confirmation mail is received', async () => {
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
        INSERT INTO auth.users VALUES ('${owner}');
      `);
      for (const name of [
        '20261002000020_email_forwarding_routes.sql',
        '20261002000030_email_forwarding_subaddresses.sql',
        '20261003000000_email_forwarding_smtp_addresses.sql',
        '20261003000010_email_forwarding_user_confirmation.sql'
      ]) {
        await db.exec(readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8'));
      }
      await db.exec(
        `INSERT INTO email_forwarding_routes(user_id,address) VALUES ('${owner}','capture+${'b'.repeat(48)}@mail.example.com')`
      );
      await expect(
        db.exec(
          `UPDATE email_forwarding_routes SET user_confirmed_at=now() WHERE user_id='${owner}'`
        )
      ).rejects.toThrow();
      await db.exec(
        `UPDATE email_forwarding_routes SET confirmation_received_at=now() WHERE user_id='${owner}'`
      );
      await db.exec(
        `UPDATE email_forwarding_routes SET user_confirmed_at=now() WHERE user_id='${owner}'`
      );
      const { rows } = await db.query<{ user_confirmed_at: string | null }>(
        'SELECT user_confirmed_at FROM email_forwarding_routes'
      );
      expect(rows[0].user_confirmed_at).not.toBeNull();
    } finally {
      await db.close();
    }
  });
  it('replaces undeliverable addresses and enforces the SMTP local-part limit', async () => {
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
      for (const name of [
        '20261002000020_email_forwarding_routes.sql',
        '20261002000030_email_forwarding_subaddresses.sql'
      ]) {
        await db.exec(readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8'));
      }
      await db.exec(`
        INSERT INTO public.email_forwarding_routes
          (user_id, address, confirmation_received_at, verification_text)
        VALUES
          ('${owner}', 'capture+${'a'.repeat(64)}@mail.example.com', now(), 'Old code'),
          ('${stranger}', '${legacyAddress}', now(), 'Old code');
      `);

      const migration = join(
        process.cwd(),
        'supabase/migrations/20261003000000_email_forwarding_smtp_addresses.sql'
      );
      expect(existsSync(migration)).toBe(true);
      await db.exec(readFileSync(migration, 'utf8'));

      const { rows } = await db.query<{
        address: string;
        confirmation_received_at: string | null;
        verification_text: string | null;
      }>(
        'SELECT address, confirmation_received_at, verification_text FROM public.email_forwarding_routes'
      );
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map(({ address }) => address)).size).toBe(2);
      for (const row of rows) {
        expect(row.address).toMatch(/^capture\+[a-f0-9]{48}@mail\.example\.com$/u);
        expect(row.address.split('@')[0].length).toBeLessThanOrEqual(64);
        expect(row.confirmation_received_at).toBeNull();
        expect(row.verification_text).toBeNull();
      }
      await expect(
        db.exec(
          `UPDATE public.email_forwarding_routes SET address='capture+${'c'.repeat(64)}@mail.example.com' WHERE user_id='${owner}'`
        )
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

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
        readFileSync(
          join(
            process.cwd(),
            'supabase/migrations/20261002000030_email_forwarding_subaddresses.sql'
          ),
          'utf8'
        )
      );
      await db.exec(
        `INSERT INTO email_forwarding_routes(user_id,address) VALUES ('${owner}','${legacyAddress}'), ('${stranger}','${address}')`
      );
      await db.exec(`SET request.jwt.claim.sub = '${owner}'; SET ROLE authenticated;`);
      expect((await db.query('SELECT address FROM email_forwarding_routes')).rows).toEqual([
        { address: legacyAddress }
      ]);
      await db.exec(
        `RESET ROLE; SET request.jwt.claim.sub = '${stranger}'; SET ROLE authenticated;`
      );
      expect((await db.query('SELECT address FROM email_forwarding_routes')).rows).toEqual([
        { address }
      ]);
      await expect(
        db.query(
          `UPDATE email_forwarding_routes SET address='capture+${'c'.repeat(64)}@mail.example.com' WHERE user_id='${stranger}'`
        )
      ).rejects.toThrow();
      await db.exec('RESET ROLE;');
      await expect(
        db.query(
          `UPDATE email_forwarding_routes SET address='capture@mail.example.com' WHERE user_id='${stranger}'`
        )
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});
