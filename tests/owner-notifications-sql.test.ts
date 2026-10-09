import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(
  new URL('../supabase/migrations/20261008000010_monthly_budgets.sql', import.meta.url)
);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const food = '33333333-3333-4333-8333-333333333333';
const dining = '44444444-4444-4444-8444-444444444444';
const investments = '55555555-5555-4555-8555-555555555555';
const loans = '66666666-6666-4666-8666-666666666666';
const foreignCategory = '77777777-7777-4777-8777-777777777777';
const incomeCategory = '88888888-8888-4888-8888-888888888888';

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.categories(
      id uuid PRIMARY KEY, user_id uuid, parent_id uuid,
      name text NOT NULL, slug text NOT NULL, type text NOT NULL,
      is_active boolean NOT NULL DEFAULT true, deleted_at timestamptz
    );
    CREATE TABLE public.transactions(
      id uuid PRIMARY KEY, user_id uuid NOT NULL, category_id uuid,
      date date NOT NULL, amount numeric(15,2) NOT NULL, currency text,
      type text NOT NULL, deleted_at timestamptz, duplicate_status text
    );
    CREATE TABLE public.investment_trades(user_id uuid, source_transaction_id uuid);
    CREATE TABLE public.personal_receivable_events(user_id uuid, source_transaction_id uuid,
      kind text);
    CREATE TABLE public.manual_loan_events(user_id uuid, source_transaction_id uuid,
      kind text);
    CREATE TABLE public.relief_fund_entries(user_id uuid, transaction_id uuid, kind text);
    INSERT INTO auth.users VALUES ('${owner}'), ('${other}');
    INSERT INTO public.categories(id,user_id,parent_id,name,slug,type) VALUES
      ('${food}','${owner}',null,'Food','food','expense'),
      ('${dining}','${owner}','${food}','Dining','dining','expense'),
      ('${investments}','${owner}',null,'Investments','investments','expense'),
      ('${loans}','${owner}',null,'Loans','loans','expense'),
      ('${foreignCategory}','${other}',null,'Other user','other','expense'),
      ('${incomeCategory}','${owner}',null,'Salary','salary','income');
    INSERT INTO public.transactions VALUES
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','${owner}','${food}',
        '2026-10-02',100,'COP','expense',null,null),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','${owner}','${dining}',
        '2026-10-03',200,'COP','expense',null,null),
      ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','${owner}','${dining}',
        '2026-10-04',50,'COP','expense',null,'pending_review'),
      ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','${owner}','${dining}',
        '2026-10-05',60,'COP','expense',now(),null),
      ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','${owner}','${dining}',
        '2026-10-06',10,'USD','expense',null,null),
      ('ffffffff-ffff-4fff-8fff-ffffffffffff','${owner}','${dining}',
        '2026-10-07',30,'COP','expense',null,null),
      ('10101010-1010-4010-8010-101010101010','${owner}','${dining}',
        '2026-10-08',40,'COP','expense',null,null),
      ('20202020-2020-4020-8020-202020202020','${owner}','${dining}',
        '2026-10-09',50,'COP','expense',null,null),
      ('30303030-3030-4030-8030-303030303030','${owner}','${dining}',
        '2026-10-10',20,'COP','expense',null,null),
      ('99999999-9999-4999-8999-999999999999','${other}','${foreignCategory}',
        '2026-10-02',5000,'COP','expense',null,null);
    INSERT INTO public.relief_fund_entries VALUES
      ('${owner}','ffffffff-ffff-4fff-8fff-ffffffffffff','outlay');
    INSERT INTO public.personal_receivable_events VALUES
      ('${owner}','10101010-1010-4010-8010-101010101010','disbursement');
    INSERT INTO public.investment_trades VALUES
      ('${owner}','20202020-2020-4020-8020-202020202020');
    INSERT INTO public.manual_loan_events VALUES
      ('${owner}','30303030-3030-4030-8030-303030303030','payment');
    ALTER TABLE public.transactions ADD COLUMN description text NOT NULL DEFAULT 'Recorded expense';
  `);
  if (!migration) throw new Error('Monthly budget migration is missing');
  await db.exec(migration);
  await db.exec(
    readFileSync(
      new URL('../supabase/migrations/20261008000020_recurring_budgets.sql', import.meta.url),
      'utf8'
    )
  );
  await db.exec(`
    CREATE TABLE public.email_forwarding_routes(user_id uuid PRIMARY KEY, confirmation_received_at timestamptz, user_confirmed_at timestamptz);
    CREATE TABLE public.shortcut_inbox_items(id uuid PRIMARY KEY, user_id uuid, source text, raw_text text, received_at timestamptz, status text);
    INSERT INTO public.shortcut_inbox_items VALUES
      ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa','${owner}','forwarded_email', E'From: bank@example.com\\nSubject: Purchase confirmed https://logo.test/a.png\\nhttps://logo.test/logo.png', now(),'pending'),
      ('bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb','${other}','forwarded_email','Other private mail',now(),'pending');
    UPDATE public.transactions SET date = date_trunc('month',now() AT TIME ZONE 'America/Bogota')::date + 1;
  `);
  await db.exec('ALTER TABLE auth.users ADD COLUMN raw_app_meta_data jsonb');
  await db.exec(
    readFileSync(
      new URL('../supabase/migrations/20261008000022_legal_acceptance.sql', import.meta.url),
      'utf8'
    )
  );
  await db.exec(
    readFileSync(
      new URL('../supabase/migrations/20261008000027_owner_notifications.sql', import.meta.url),
      'utf8'
    )
  );
  await db.exec(
    readFileSync(
      new URL('../supabase/migrations/20261008000030_notification_terms_gate.sql', import.meta.url),
      'utf8'
    )
  );
  return db;
}

async function asOwner(db: PGlite, user = owner): Promise<void> {
  await db.exec(`SET request.jwt.claim.sub = '${user}'; SET ROLE authenticated;`);
}
interface Notices {
  data: Array<{ id: string; kind: string; label: string; read_at: string | null }>;
  unread_count: number;
  total_count: number;
  pending_email_count: number;
  budget_warning_count: number;
}
async function refresh(db: PGlite): Promise<Notices> {
  return (
    await db.query<{ value: Notices }>('SELECT public.refresh_owner_notifications() AS value')
  ).rows[0].value;
}
describe('persistent owner notifications SQL', () => {
  it('gates emails, deduplicates refresh, isolates owners and keeps financial review untouched', async () => {
    const db = await database();
    try {
      await db.exec('SET ROLE anon');
      await expect(refresh(db)).rejects.toThrow(/permission denied/i);
      await db.exec('RESET ROLE');
      await expect(refresh(db)).rejects.toThrow(/Authentication required/i);
      await asOwner(db);
      expect((await refresh(db)).data).toEqual([]);
      await db.exec(
        `RESET ROLE; INSERT INTO public.email_forwarding_routes VALUES ('${owner}',now(),NULL);`
      );
      await asOwner(db);
      expect((await refresh(db)).pending_email_count).toBe(0);
      await db.exec(
        `RESET ROLE; UPDATE public.email_forwarding_routes SET user_confirmed_at=now();`
      );
      await asOwner(db);
      const first = await refresh(db);
      expect(first.pending_email_count).toBe(1);
      expect(first.unread_count).toBe(1);
      expect(first.data[0].label).toBe('Purchase confirmed');
      await db.exec('RESET ROLE');
      const samples = [
        [
          'From (unverified): sender@example.com\n\nAlertas y Notificaciones\n\nLogo [https://bank.test/logo.png]\n¡Listo!\nBancolombia: Compraste $45.000 en Mercado.\nhttps://bank.test/footer',
          'Bancolombia: Compraste $45.000 en Mercado.'
        ],
        [
          'From (unverified): sender@example.com\nLogo [https://bank.test/logo.png]\nRealizaste una compra de $10.000.',
          'Realizaste una compra de $10.000.'
        ],
        [
          'From (unverified): sender@example.com\nLogo\nHiciste el pago de tu tarjeta.',
          'Hiciste el pago de tu tarjeta.'
        ],
        [
          'From (unverified): sender@example.com\nhttps://bank.test/logo.png\nPlain bank message\nFooter',
          'Plain bank message'
        ]
      ];
      for (const [raw, expected] of samples) {
        const result = await db.query<{ label: string }>(
          'SELECT public.notification_email_excerpt($1) AS label',
          [raw]
        );
        expect(result.rows[0].label).toBe(expected);
      }
      expect(
        (
          await db.query<{ label: string }>(
            'SELECT public.notification_email_excerpt($1) AS label',
            ['Bancolombia: ' + 'x'.repeat(300)]
          )
        ).rows[0].label
      ).toHaveLength(180);
      await asOwner(db);
      expect((await refresh(db)).data).toEqual(first.data);
      await asOwner(db, other);
      expect((await refresh(db)).data).toEqual([]);
      expect((await db.query('SELECT * FROM public.owner_notifications')).rows).toEqual([]);
      expect(
        (
          await db.query<{ count: number }>(
            'SELECT public.mark_owner_notifications_read($1) AS count',
            [first.data[0].id]
          )
        ).rows[0].count
      ).toBe(0);
      await expect(db.exec('UPDATE public.owner_notifications SET read_at=now()')).rejects.toThrow(
        /permission denied/i
      );
      await asOwner(db);
      await db.query('SELECT public.mark_owner_notifications_read($1)', [first.data[0].id]);
      expect((await refresh(db)).unread_count).toBe(0);
      expect((await refresh(db)).pending_email_count).toBe(1);
      await db.exec('RESET ROLE');
      expect(
        (
          await db.query<{ status: string }>(
            'SELECT status FROM public.shortcut_inbox_items WHERE user_id=$1',
            [owner]
          )
        ).rows[0].status
      ).toBe('pending');
    } finally {
      await db.close();
    }
  }, 30_000);
  it('generates independent 80% and 100% notices per month from authoritative budget totals', async () => {
    const db = await database();
    try {
      await asOwner(db);
      const save = (limit: number) =>
        db.query(
          `SELECT public.upsert_monthly_budget(date_trunc('month',now() AT TIME ZONE 'America/Bogota')::date,$1::uuid,$2::numeric)`,
          [food, limit]
        );
      await save(375);
      expect((await refresh(db)).data.map((n) => n.kind)).toEqual(['budget_near']);
      await save(300);
      const notices = await refresh(db);
      expect(notices.data.map((n) => n.kind).sort()).toEqual(['budget_exceeded', 'budget_near']);
      expect(notices.budget_warning_count).toBe(1);
      expect((await refresh(db)).data).toHaveLength(2);
      await db.query('SELECT public.mark_owner_notifications_read()');
      expect((await refresh(db)).unread_count).toBe(0);
      await asOwner(db, other);
      expect((await refresh(db)).budget_warning_count).toBe(0);
      await db.exec(
        `RESET ROLE; INSERT INTO public.categories(id,user_id,name,slug,type) VALUES ('90909090-9090-4090-8090-909090909090',NULL,'Global','global','expense')`
      );
      await asOwner(db);
      await expect(
        db.query(
          `SELECT public.upsert_monthly_budget(date_trunc('month',now())::date,'90909090-9090-4090-8090-909090909090',100)`
        )
      ).rejects.toThrow(/Owned active expense category/i);
    } finally {
      await db.close();
    }
  }, 30_000);
  it('paginates all historical owner notices and filters unread without marking them', async () => {
    const db = await database();
    try {
      await db.exec(`INSERT INTO public.owner_notifications(user_id,notice_key,kind,source_id,label,created_at)
        SELECT '${owner}', 'history:'||n, 'budget_near', gen_random_uuid(), 'Owned '||n, now()-n*interval '1 minute' FROM generate_series(1,101) n;
        INSERT INTO public.owner_notifications(user_id,notice_key,kind,source_id,label) VALUES ('${other}','foreign','budget_near',gen_random_uuid(),'Foreign');`);
      await asOwner(db);
      const page = (unread = false) =>
        db.query<{ value: Notices }>(
          'SELECT public.refresh_owner_notifications(20,100,$1) AS value',
          [unread]
        );
      const old = (await page()).rows[0].value;
      expect(old.total_count).toBe(101);
      expect(old.unread_count).toBe(101);
      expect(old.data).toHaveLength(1);
      expect(old.data[0].label).toBe('Owned 101');
      expect((await page(true)).rows[0].value.data).toHaveLength(1);
      await db.query('SELECT public.mark_owner_notifications_read($1)', [old.data[0].id]);
      const filtered = (await page(true)).rows[0].value;
      expect(filtered.total_count).toBe(100);
      expect(filtered.unread_count).toBe(100);
      expect(filtered.data).toEqual([]);
      expect((await page()).rows[0].value.data[0].read_at).not.toBeNull();
      await expect(
        db.query('SELECT public.refresh_owner_notifications(101,0,false)')
      ).rejects.toThrow(/pagination/i);
      await expect(
        db.query('SELECT public.refresh_owner_notifications(20,-1,false)')
      ).rejects.toThrow(/pagination/i);
      await asOwner(db, other);
      expect((await refresh(db)).total_count).toBe(1);
    } finally {
      await db.close();
    }
  }, 30_000);
  it('requires current terms for newly registered owners on direct reads and definer RPCs', async () => {
    const db = await database();
    const registered = '12121212-1212-4212-8212-121212121212';
    try {
      await db.exec(`INSERT INTO auth.users(id) VALUES ('${registered}');
        INSERT INTO public.owner_notifications(user_id,notice_key,kind,source_id,label)
        VALUES ('${registered}','terms-test','budget_near',gen_random_uuid(),'Private notice');`);
      await asOwner(db, registered);
      expect((await db.query('SELECT * FROM public.owner_notifications')).rows).toEqual([]);
      await expect(refresh(db)).rejects.toThrow(/Terms acceptance required/i);
      await expect(db.query('SELECT public.mark_owner_notifications_read()')).rejects.toThrow(
        /Terms acceptance required/i
      );
      await expect(
        db.query('SELECT public.mark_owner_notifications_read($1)', [
          'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
        ])
      ).rejects.toThrow(/Terms acceptance required/i);
      await db.exec('RESET ROLE');
      await expect(
        db.exec(`INSERT INTO public.owner_notifications(user_id,notice_key,kind,source_id,label)
        VALUES ('${registered}','blocked-write','budget_near',gen_random_uuid(),'Blocked')`)
      ).rejects.toThrow(/Terms acceptance required/i);
      await asOwner(db, registered);
      await db.query("SELECT public.accept_current_terms('2026-10-08')");
      const accepted = await refresh(db);
      expect(accepted.data).toHaveLength(1);
      expect(accepted.unread_count).toBe(1);
      await db.query('SELECT public.mark_owner_notifications_read($1)', [accepted.data[0].id]);
      expect((await refresh(db)).unread_count).toBe(0);
    } finally {
      await db.close();
    }
  }, 30_000);
});
