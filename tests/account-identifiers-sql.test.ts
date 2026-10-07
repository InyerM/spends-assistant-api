import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../supabase/migrations/20261006000060_account_identifiers.sql', import.meta.url),
  'utf8'
);

describe('account identifiers', () => {
  it('migrates suffixes and projects the active primary while retaining retired cards', async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE TABLE public.accounts (
        id uuid PRIMARY KEY, user_id uuid NOT NULL, type text NOT NULL,
        institution text, last_four text, bank_account_last_four text,
        deleted_at timestamptz
      );
      INSERT INTO public.accounts VALUES
      ('11111111-1111-4111-8111-111111111111',
       '22222222-2222-4222-8222-222222222222',
       'savings','Bancolombia','7799','2651',NULL);`);
      await db.exec(migration);
      const before = await db.query<{ identifiers: Array<{ kind: string; last_four: string }> }>(
        'SELECT identifiers FROM public.accounts'
      );
      expect(before.rows[0].identifiers).toEqual([
        { kind: 'debit_card', last_four: '7799', is_active: true, is_primary: true },
        { kind: 'bank_account', last_four: '2651', is_active: true, is_primary: false }
      ]);
      await db.exec(`UPDATE public.accounts SET identifiers = '[
        {"kind":"bank_account","last_four":"2651","is_active":true,"is_primary":true},
        {"kind":"debit_card","last_four":"9989","is_active":true,"is_primary":false},
        {"kind":"debit_card","last_four":"7799","is_active":false,"is_primary":false}
      ]' WHERE last_four='7799'`);
      const after = await db.query<{ last_four: string; bank_account_last_four: string }>(
        'SELECT last_four,bank_account_last_four FROM public.accounts'
      );
      expect(after.rows).toEqual([{ last_four: '2651', bank_account_last_four: '2651' }]);
      await db.exec(`INSERT INTO public.accounts(id,user_id,type,institution,last_four)
        VALUES ('33333333-3333-4333-8333-333333333333',
          '22222222-2222-4222-8222-222222222222','credit_card','Lulo','8456')`);
      expect(
        (
          await db.query<{ identifiers: Array<{ last_four: string }> }>(
            `SELECT identifiers FROM public.accounts WHERE last_four='8456'`
          )
        ).rows[0].identifiers[0].last_four
      ).toBe('8456');
      await expect(
        db.exec(`UPDATE public.accounts SET identifiers='[
        {"kind":"debit_card","last_four":"9989","is_active":true,"is_primary":true},
        {"kind":"debit_card","last_four":"9989","is_active":true,"is_primary":false}
      ]'`)
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});
