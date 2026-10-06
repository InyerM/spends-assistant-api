import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../supabase/migrations/20261006000000_user_account_deletion_cascade.sql',
    import.meta.url
  ),
  'utf8'
);

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const legacyTables = [
  'accounts',
  'categories',
  'transactions',
  'automation_rules',
  'reconciliations',
  'imports',
  'skipped_messages'
];

describe('user account deletion cascades legacy owner records', () => {
  it('deletes all seven legacy tables for one auth user and preserves another owner', async () => {
    const db = new PGlite();
    try {
      await db.exec(
        'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);'
      );
      for (const table of legacyTables) {
        await db.exec(`CREATE TABLE public.${table} (
          id uuid PRIMARY KEY, user_id uuid REFERENCES auth.users(id));`);
      }
      await db.exec(migration);
      expect(
        (
          await db.query<{ account_deletion_ready: boolean }>(
            'SELECT public.account_deletion_ready()'
          )
        ).rows
      ).toEqual([{ account_deletion_ready: true }]);
      expect(
        (
          await db.query<{ authenticated: boolean; service_role: boolean }>(
            `SELECT has_function_privilege('authenticated','public.account_deletion_ready()','EXECUTE') AS authenticated,
              has_function_privilege('service_role','public.account_deletion_ready()','EXECUTE') AS service_role`
          )
        ).rows
      ).toEqual([{ authenticated: false, service_role: true }]);
      await db.exec(`INSERT INTO auth.users(id) VALUES ('${owner}'), ('${other}');`);
      for (const [index, table] of legacyTables.entries()) {
        await db.exec(`INSERT INTO public.${table}(id,user_id) VALUES
          ('00000000-0000-4000-8000-${String(index * 2 + 1).padStart(12, '0')}', '${owner}'),
          ('00000000-0000-4000-8000-${String(index * 2 + 2).padStart(12, '0')}', '${other}');`);
      }
      await db.exec(`DELETE FROM auth.users WHERE id = '${owner}';`);
      for (const table of legacyTables) {
        const { rows } = await db.query<{ user_id: string }>(`SELECT user_id FROM public.${table}`);
        expect(rows, table).toEqual([{ user_id: other }]);
      }
    } finally {
      await db.close();
    }
  });
});
