import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
const migration = new URL(
  '../supabase/migrations/20261008000028_managed_account_rules.sql',
  import.meta.url
);
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const account = '33333333-3333-4333-8333-333333333333';
async function setup(applyMigration = true): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE TABLE public.accounts(id uuid PRIMARY KEY, user_id uuid NOT NULL, name text, type text, institution text, last_four text, bank_account_last_four text, is_active boolean DEFAULT true, deleted_at timestamptz);
    CREATE TABLE public.automation_rules(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, name text NOT NULL, is_active boolean DEFAULT true, priority integer DEFAULT 0, rule_type text DEFAULT 'general', condition_logic text DEFAULT 'or', conditions jsonb NOT NULL, actions jsonb NOT NULL, deleted_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    INSERT INTO public.automation_rules(user_id,name,conditions,actions,rule_type) VALUES ('${owner}','Custom detection','{}','{"set_account":"${account}"}','account_detection');
    ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
    CREATE POLICY owned_accounts ON public.accounts TO authenticated USING (user_id=auth.uid()) WITH CHECK (user_id=auth.uid());
    GRANT USAGE ON SCHEMA auth TO authenticated;
    GRANT SELECT,INSERT,UPDATE ON public.accounts,public.automation_rules TO authenticated;`);
  await db.exec(
    readFileSync(
      new URL('../supabase/migrations/20261006000060_account_identifiers.sql', import.meta.url),
      'utf8'
    )
  );
  if (applyMigration && existsSync(migration)) await db.exec(readFileSync(migration, 'utf8'));
  return db;
}
async function createAccount(db: PGlite): Promise<void> {
  await db.exec(
    `INSERT INTO public.accounts(id,user_id,name,type,institution,last_four,identifiers) VALUES ('${account}','${owner}','Savings','savings','Bancolombia','2651','[{"kind":"bank_account","last_four":"2651","is_active":true,"is_primary":true},{"kind":"debit_card","last_four":"9989","is_active":true,"is_primary":false},{"kind":"debit_card","last_four":"7799","is_active":false,"is_primary":false}]')`
  );
}
describe('managed account detection rules', () => {
  it('creates one AND rule per active alias, updates idempotently and preserves custom rules', async () => {
    const db = await setup();
    try {
      await createAccount(db);
      let rules = await db.query<{ conditions: unknown; condition_logic: string; name: string }>(
        `SELECT conditions,condition_logic,name FROM public.automation_rules WHERE name <> 'Custom detection' ORDER BY name`
      );
      expect(rules.rows.map((r) => r.conditions)).toEqual([
        { raw_text_contains: ['Bancolombia', '2651'] },
        { raw_text_contains: ['Bancolombia', '9989'] }
      ]);
      expect(rules.rows.map((r) => r.condition_logic)).toEqual(['and', 'and']);
      const ids = (await db.query('SELECT id FROM public.automation_rules ORDER BY id')).rows;
      await db.exec(
        `UPDATE public.accounts SET name='Renamed',institution='New Bank' WHERE id='${account}'; UPDATE public.accounts SET name=name WHERE id='${account}';`
      );
      expect((await db.query('SELECT id FROM public.automation_rules ORDER BY id')).rows).toEqual(
        ids
      );
      rules = await db.query(
        `SELECT conditions,condition_logic,name FROM public.automation_rules WHERE name='Custom detection'`
      );
      expect(rules.rows).toEqual([
        { conditions: {}, condition_logic: 'or', name: 'Custom detection' }
      ]);
    } finally {
      await db.close();
    }
  });
  it('retires aliases and archived accounts without deleting custom rules; restores the same managed row', async () => {
    const db = await setup();
    try {
      await createAccount(db);
      await db.exec(
        `UPDATE public.accounts SET identifiers='[{"kind":"bank_account","last_four":"2651","is_active":true,"is_primary":true},{"kind":"debit_card","last_four":"9989","is_active":false,"is_primary":false}]' WHERE id='${account}'`
      );
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM public.automation_rules WHERE deleted_at IS NULL'
          )
        ).rows
      ).toEqual([{ n: 2 }]);
      await db.exec(`UPDATE public.accounts SET is_active=false WHERE id='${account}'`);
      expect(
        (await db.query('SELECT name FROM public.automation_rules WHERE deleted_at IS NULL')).rows
      ).toEqual([{ name: 'Custom detection' }]);
      await db.exec(`UPDATE public.accounts SET is_active=true WHERE id='${account}'`);
      expect(
        (await db.query('SELECT count(*)::int AS n FROM public.automation_rules')).rows
      ).toEqual([{ n: 3 }]);
    } finally {
      await db.close();
    }
  });
  it('rejects forged managed markers and scopes manual resync to the caller', async () => {
    const db = await setup();
    try {
      await createAccount(db);
      await db.exec(`SET request.jwt.claim.sub='${other}'; SET ROLE authenticated`);
      await expect(
        db.exec(
          `INSERT INTO public.automation_rules(user_id,name,conditions,actions,managed_account_id,managed_identifier) VALUES ('${other}','Forged','{}','{}','${account}','2651')`
        )
      ).rejects.toThrow(/managed/i);
      expect(
        (await db.query('SELECT public.sync_owned_account_detection_rules() AS n')).rows
      ).toEqual([{ n: 0 }]);
      await db.exec('RESET ROLE');
      await expect(
        db.exec(
          `UPDATE public.automation_rules SET name='Edited' WHERE managed_account_id='${account}'`
        )
      ).rejects.toThrow(/account identifiers/i);
      await expect(
        db.exec(`DELETE FROM public.automation_rules WHERE managed_account_id='${account}'`)
      ).rejects.toThrow(/account identifiers/i);
    } finally {
      await db.close();
    }
  });
  it('backfills existing accounts and skips cash or missing recognition details', async () => {
    const db = await setup(false);
    try {
      await createAccount(db);
      await db.exec(`INSERT INTO public.accounts(id,user_id,name,type,institution) VALUES
        ('44444444-4444-4444-8444-444444444444','${owner}','Cash','cash','Bancolombia'),
        ('55555555-5555-4555-8555-555555555555','${owner}','Unknown','savings','   ');`);
      await db.exec(readFileSync(migration, 'utf8'));
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM public.automation_rules WHERE managed_account_id IS NOT NULL AND deleted_at IS NULL'
          )
        ).rows
      ).toEqual([{ n: 2 }]);
    } finally {
      await db.close();
    }
  });
  it('preserves physical account deletion cascades without weakening managed rule guards', async () => {
    const db = await setup();
    try {
      await createAccount(db);
      await db.exec(`DELETE FROM public.accounts WHERE id='${account}'`);
      expect((await db.query('SELECT name FROM public.automation_rules')).rows).toEqual([
        { name: 'Custom detection' }
      ]);
    } finally {
      await db.close();
    }
  });
  it('bridges legacy primary-ending edits, preserves active aliases and enforces owner scope and the alias limit', async () => {
    const db = await setup();
    try {
      await createAccount(db);
      await db.exec(
        `SET request.jwt.claim.sub='${other}'; SET ROLE authenticated; UPDATE public.accounts SET last_four='1234' WHERE id='${account}'; RESET ROLE;`
      );
      expect((await db.query('SELECT last_four FROM public.accounts')).rows).toEqual([
        { last_four: '2651' }
      ]);
      await db.exec(
        `SET request.jwt.claim.sub='${owner}'; SET ROLE authenticated; UPDATE public.accounts SET last_four='1234' WHERE id='${account}'; RESET ROLE;`
      );
      const row = (
        await db.query<{
          identifiers: Array<{ last_four: string; is_active: boolean; is_primary: boolean }>;
        }>('SELECT identifiers FROM public.accounts')
      ).rows[0];
      expect(
        row.identifiers.filter((alias) => alias.is_active).map((alias) => alias.last_four)
      ).toEqual(['2651', '9989', '1234']);
      expect(
        row.identifiers.filter((alias) => alias.is_primary).map((alias) => alias.last_four)
      ).toEqual(['1234']);
      expect(row.identifiers.find((alias) => alias.last_four === '7799')?.is_active).toBe(false);
      const aliases = Array.from({ length: 12 }, (_, index) => ({
        kind: 'bank_account',
        last_four: String(1000 + index),
        is_active: true,
        is_primary: index === 0
      }));
      await db.query('UPDATE public.accounts SET identifiers=$1::jsonb WHERE id=$2::uuid', [
        JSON.stringify(aliases),
        account
      ]);
      await expect(
        db.exec(`UPDATE public.accounts SET last_four='9999' WHERE id='${account}'`)
      ).rejects.toThrow(/identifiers/i);
    } finally {
      await db.close();
    }
  });
});
