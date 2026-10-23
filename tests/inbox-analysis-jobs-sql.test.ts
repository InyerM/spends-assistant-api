import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const inbox = '10000000-0000-4000-8000-000000000001';
const category = '20000000-0000-4000-8000-000000000001';
const account = '30000000-0000-4000-8000-000000000001';
const file = (name: string): string =>
  readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8');
async function database(historical = false): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role; CREATE SCHEMA auth;
 CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
 INSERT INTO auth.users VALUES ('${owner}'),('${other}');
 CREATE TABLE public.accounts(id uuid PRIMARY KEY,user_id uuid,is_active boolean DEFAULT true,deleted_at timestamptz,balance numeric DEFAULT 99);
 CREATE TABLE public.categories(id uuid PRIMARY KEY,user_id uuid,is_active boolean DEFAULT true,deleted_at timestamptz,type text DEFAULT 'expense');
 CREATE TABLE public.transactions(id uuid PRIMARY KEY);
 INSERT INTO public.accounts(id,user_id) VALUES ('${account}','${owner}');
 INSERT INTO public.categories(id,user_id) VALUES ('${category}','${owner}');`);
  await db.exec(file('20260929000030_shortcut_inbox.sql'));
  await db.exec('ALTER TABLE public.shortcut_inbox_items ADD UNIQUE(id,user_id)');
  for (const name of [
    '20261002000020_email_forwarding_routes.sql',
    '20261003000010_email_forwarding_user_confirmation.sql',
    '20261006000020_external_ai_consent.sql',
    '20261006000010_forwarded_email_analysis.sql',
    '20261006000030_forwarded_email_review_copy.sql',
    '20261006000050_forwarded_email_review_provenance.sql',
    '20261006000070_forwarded_email_automation_source.sql',
    '20261022000010_inbox_analysis_jobs.sql'
  ]) {
    if (historical && name === '20261022000010_inbox_analysis_jobs.sql')
      await db.exec(
        `INSERT INTO public.shortcut_inbox_items(id,user_id,source,received_at,raw_text,idempotency_key) VALUES ('${inbox}','${owner}','sms-shortcut',now(),'Synthetic purchase',repeat('a',64));`
      );
    await db.exec(file(name));
  }
  if (!historical)
    await db.exec(
      `INSERT INTO public.shortcut_inbox_items(id,user_id,source,received_at,raw_text,idempotency_key) VALUES ('${inbox}','${owner}','sms-shortcut',now(),'Synthetic purchase',repeat('a',64));`
    );
  return db;
}
async function service<T>(db: PGlite, sql: string): Promise<T[]> {
  await db.exec('SET ROLE service_role');
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec('RESET ROLE');
  }
}
async function claim(db: PGlite): Promise<string> {
  const rows = await service<{ lease_token: string }>(
    db,
    'SELECT * FROM public.claim_inbox_analysis_jobs()'
  );
  return rows[0]!.lease_token;
}
const proposal = () =>
  JSON.stringify({
    status: 'needs_review',
    amount: 12000,
    account_id: account,
    category_id: category,
    category_source: 'automation',
    suggested_type: 'expense',
    description: 'Coffee',
    notes: 'Owner history',
    analysis_details: { analysis_source: 'automation' }
  });
const complete = (lease: string, analysis = proposal()) =>
  `SELECT public.complete_inbox_analysis_job('${inbox}','${owner}','${lease}','${analysis}'::jsonb) AS done`;
describe('durable suggestion-only analysis jobs', () => {
  it('claims once and completes proposal+job atomically without financial writes', async () => {
    const db = await database();
    try {
      const lease = await claim(db);
      expect(await service(db, 'SELECT * FROM public.claim_inbox_analysis_jobs()')).toEqual([]);
      expect(await service(db, complete(lease))).toEqual([{ done: true }]);
      expect(await service(db, complete(lease))).toEqual([{ done: false }]);
      expect(
        (await db.query('SELECT state,attempts FROM public.inbox_analysis_jobs')).rows
      ).toEqual([{ state: 'ready', attempts: 1 }]);
      expect(
        (
          await db.query(
            'SELECT analysis_version,description,analysis_details FROM public.forwarded_email_analyses'
          )
        ).rows
      ).toEqual([
        {
          analysis_version: 3,
          description: 'Coffee',
          analysis_details: { analysis_source: 'automation' }
        }
      ]);
      expect((await db.query('SELECT balance FROM public.accounts')).rows).toEqual([
        { balance: '99' }
      ]);
      expect((await db.query('SELECT * FROM public.transactions')).rows).toEqual([]);
    } finally {
      await db.close();
    }
  });
  it('isolates owner status reads and denies client writes, lease reads and RPC execution', async () => {
    const db = await database();
    try {
      await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub='${other}'`);
      expect(
        (await db.query('SELECT inbox_item_id,state FROM public.inbox_analysis_jobs')).rows
      ).toEqual([]);
      await db.exec(`SET request.jwt.claim.sub='${owner}'`);
      expect((await db.query('SELECT state FROM public.inbox_analysis_jobs')).rows).toEqual([
        { state: 'pending' }
      ]);
      await expect(
        db.query('SELECT lease_token FROM public.inbox_analysis_jobs')
      ).rejects.toThrow();
      await expect(
        db.query("UPDATE public.inbox_analysis_jobs SET state='ready'")
      ).rejects.toThrow();
      for (const sql of [
        'SELECT * FROM public.claim_inbox_analysis_jobs()',
        `SELECT public.request_inbox_analysis_job('${inbox}','${owner}')`,
        complete('00000000-0000-4000-8000-000000000009'),
        `SELECT public.fail_inbox_analysis_job('${inbox}','${owner}','00000000-0000-4000-8000-000000000009','provider_unavailable')`
      ])
        await expect(db.query(sql)).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
  it('discards expired/replaced leases and reviewed items, and makes repeated enqueue idempotent', async () => {
    const db = await database();
    try {
      const old = await claim(db);
      await db.exec("UPDATE public.inbox_analysis_jobs SET leased_until=now()-interval '1 second'");
      const fresh = await claim(db);
      expect(fresh).not.toBe(old);
      expect(await service(db, complete(old))).toEqual([{ done: false }]);
      await db.exec(
        `UPDATE public.shortcut_inbox_items SET status='dismissed' WHERE id='${inbox}'`
      );
      expect(await service(db, complete(fresh))).toEqual([{ done: false }]);
      expect(
        (await db.query('SELECT state,lease_token FROM public.inbox_analysis_jobs')).rows
      ).toEqual([{ state: 'skipped', lease_token: null }]);
      await db.exec(
        `UPDATE public.shortcut_inbox_items SET status='pending' WHERE id='${inbox}'; UPDATE public.shortcut_inbox_items SET status='pending' WHERE id='${inbox}'`
      );
      expect(
        (await db.query('SELECT count(*)::int AS count FROM public.inbox_analysis_jobs')).rows
      ).toEqual([{ count: 1 }]);
    } finally {
      await db.close();
    }
  });
  it('rejects foreign/inactive references and oversized or unknown suggestion fields atomically', async () => {
    const db = await database();
    try {
      const lease = await claim(db);
      await db.exec(`UPDATE public.categories SET user_id='${other}'`);
      await expect(service(db, complete(lease))).rejects.toThrow();
      await db.exec(
        `UPDATE public.categories SET user_id='${owner}'; UPDATE public.accounts SET is_active=false`
      );
      await expect(service(db, complete(lease))).rejects.toThrow();
      await db.exec('UPDATE public.accounts SET is_active=true');
      await expect(
        service(
          db,
          complete(
            lease,
            JSON.stringify({
              ...JSON.parse(proposal()),
              analysis_details: { text: 'x'.repeat(17000) }
            })
          )
        )
      ).rejects.toThrow();
      await expect(
        service(db, complete(lease, JSON.stringify({ ...JSON.parse(proposal()), balance: 3 })))
      ).rejects.toThrow();
      expect((await db.query('SELECT * FROM public.forwarded_email_analyses')).rows).toEqual([]);
      expect((await db.query('SELECT state FROM public.inbox_analysis_jobs')).rows).toEqual([
        { state: 'running' }
      ]);
    } finally {
      await db.close();
    }
  });
  it('does not automatically analyze historical captures', async () => {
    const db = await database(true);
    try {
      expect((await db.query('SELECT * FROM public.inbox_analysis_jobs')).rows).toEqual([]);
      await service(db, `SELECT public.request_inbox_analysis_job('${inbox}','${owner}')`);
      expect((await db.query('SELECT state FROM public.inbox_analysis_jobs')).rows).toEqual([
        { state: 'pending' }
      ]);
    } finally {
      await db.close();
    }
  });
  it('keeps running claims stable, preserves ready cache and scopes explicit reanalysis', async () => {
    const db = await database();
    try {
      const [first, second] = await Promise.all([
        service<{ lease_token: string }>(db, 'SELECT * FROM public.claim_inbox_analysis_jobs()'),
        service<{ lease_token: string }>(db, 'SELECT * FROM public.claim_inbox_analysis_jobs()')
      ]);
      expect([...first, ...second]).toHaveLength(1);
      const lease = [...first, ...second][0]!.lease_token;
      expect(
        await service(
          db,
          `SELECT public.request_inbox_analysis_job('${inbox}','${owner}',true) AS state`
        )
      ).toEqual([{ state: 'running' }]);
      await expect(
        service(db, `SELECT public.request_inbox_analysis_job('${inbox}','${other}')`)
      ).rejects.toThrow();
      await service(db, complete(lease));
      expect(
        await service(
          db,
          `SELECT public.request_inbox_analysis_job('${inbox}','${owner}') AS state`
        )
      ).toEqual([{ state: 'ready' }]);
      expect(await service(db, 'SELECT * FROM public.claim_inbox_analysis_jobs()')).toEqual([]);
      expect(
        await service(
          db,
          `SELECT public.request_inbox_analysis_job('${inbox}','${owner}',true) AS state`
        )
      ).toEqual([{ state: 'pending' }]);
      expect((await db.query('SELECT attempts FROM public.inbox_analysis_jobs')).rows).toEqual([
        { attempts: 0 }
      ]);
    } finally {
      await db.close();
    }
  });
  it('rejects malformed scalar fields rather than accepting JSON objects as text', async () => {
    const db = await database();
    try {
      const lease = await claim(db);
      await expect(
        service(
          db,
          complete(
            lease,
            JSON.stringify({ ...JSON.parse(proposal()), description: { untrusted: 'object' } })
          )
        )
      ).rejects.toThrow();
      expect((await db.query('SELECT state FROM public.inbox_analysis_jobs')).rows).toEqual([
        { state: 'running' }
      ]);
    } finally {
      await db.close();
    }
  });
  it('fails an exhausted crashed lease instead of leaving it permanently running', async () => {
    const db = await database();
    try {
      await claim(db);
      await db.exec(
        "UPDATE public.inbox_analysis_jobs SET attempts=3,leased_until=now()-interval '1 second'"
      );
      expect(await service(db, 'SELECT * FROM public.claim_inbox_analysis_jobs()')).toEqual([]);
      expect(
        (
          await db.query(
            'SELECT state,attempts,lease_token,leased_until,last_error FROM public.inbox_analysis_jobs'
          )
        ).rows
      ).toEqual([
        {
          state: 'failed',
          attempts: 3,
          lease_token: null,
          leased_until: null,
          last_error: 'provider_unavailable'
        }
      ]);
    } finally {
      await db.close();
    }
  });
  it('caps retries, validates failure codes and allows an explicit blocked reset', async () => {
    const db = await database();
    try {
      let lease = await claim(db);
      await expect(
        service(
          db,
          `SELECT public.fail_inbox_analysis_job('${inbox}','${owner}','${lease}','private error')`
        )
      ).rejects.toThrow();
      await service(
        db,
        `SELECT public.fail_inbox_analysis_job('${inbox}','${owner}','${lease}','consent_required',60,true)`
      );
      expect(await service(db, 'SELECT * FROM public.claim_inbox_analysis_jobs()')).toEqual([]);
      await service(db, `SELECT public.request_inbox_analysis_job('${inbox}','${owner}')`);
      for (let i = 0; i < 3; i++) {
        lease = await claim(db);
        await service(
          db,
          `SELECT public.fail_inbox_analysis_job('${inbox}','${owner}','${lease}','provider_unavailable',1)`
        );
        await db.exec(
          "UPDATE public.inbox_analysis_jobs SET available_at=now()-interval '1 second'"
        );
      }
      expect(await service(db, 'SELECT * FROM public.claim_inbox_analysis_jobs()')).toEqual([]);
    } finally {
      await db.close();
    }
  });
  it('resumes only owner pending consent-blocked jobs on a current matching grant', async () => {
    const db = await database();
    try {
      const lease = await claim(db);
      await service(
        db,
        `SELECT public.fail_inbox_analysis_job('${inbox}','${owner}','${lease}','consent_required',60,true)`
      );
      const assertBlocked = async (): Promise<void> => {
        expect((await db.query('SELECT state FROM public.inbox_analysis_jobs')).rows).toEqual([
          { state: 'blocked' }
        ]);
      };
      await db.exec(
        `INSERT INTO public.ai_consent_decisions(user_id,scope,version,granted_at) VALUES ('${other}','financial_text','external-ai-v1',now()),('${owner}','document_images','external-ai-v1',now())`
      );
      await assertBlocked();
      await db.exec(
        `INSERT INTO public.ai_consent_decisions(user_id,scope,version,revoked_at) VALUES ('${owner}','financial_text','external-ai-v1',now())`
      );
      await assertBlocked();
      await db.exec(
        `UPDATE public.ai_consent_decisions SET version='old-version',granted_at=now(),revoked_at=null WHERE user_id='${owner}' AND scope='financial_text'`
      );
      await assertBlocked();
      await db.exec(
        `UPDATE public.ai_consent_decisions SET version='external-ai-v1' WHERE user_id='${owner}' AND scope='financial_text'`
      );
      expect(
        (
          await db.query(
            'SELECT state,attempts,lease_token,last_error FROM public.inbox_analysis_jobs'
          )
        ).rows
      ).toEqual([{ state: 'pending', attempts: 0, lease_token: null, last_error: null }]);
      await db.exec(
        `UPDATE public.inbox_analysis_jobs SET state='failed',last_error='provider_unavailable'; UPDATE public.ai_consent_decisions SET granted_at=now() WHERE user_id='${owner}' AND scope='financial_text'`
      );
      expect((await db.query('SELECT state FROM public.inbox_analysis_jobs')).rows).toEqual([
        { state: 'failed' }
      ]);
    } finally {
      await db.close();
    }
  });
  it('resumes forwarded-source verification blocks only after both owner confirmations', async () => {
    const db = await database();
    const email = '10000000-0000-4000-8000-000000000002';
    try {
      await db.exec(`INSERT INTO public.shortcut_inbox_items(id,user_id,source,received_at,raw_text,idempotency_key) VALUES ('${email}','${owner}','forwarded_email',now(),'Synthetic email purchase',repeat('b',64));
        UPDATE public.inbox_analysis_jobs SET state='blocked',attempts=2,last_error='unverified_source';
        INSERT INTO public.email_forwarding_routes(user_id,address,confirmation_received_at) VALUES ('${owner}','f-'||repeat('c',64)||'@example.com',now())`);
      expect(
        (await db.query('SELECT state FROM public.inbox_analysis_jobs ORDER BY inbox_item_id')).rows
      ).toEqual([{ state: 'blocked' }, { state: 'blocked' }]);
      await db.exec(
        `UPDATE public.email_forwarding_routes SET user_confirmed_at=now() WHERE user_id='${owner}'`
      );
      expect(
        (
          await db.query(
            'SELECT state,attempts,last_error FROM public.inbox_analysis_jobs ORDER BY inbox_item_id'
          )
        ).rows
      ).toEqual([
        { state: 'blocked', attempts: 2, last_error: 'unverified_source' },
        { state: 'pending', attempts: 0, last_error: null }
      ]);
      await db.exec(
        `UPDATE public.shortcut_inbox_items SET status='dismissed' WHERE id='${email}'; UPDATE public.email_forwarding_routes SET user_confirmed_at=now() WHERE user_id='${owner}'`
      );
      expect(
        (
          await db.query(
            `SELECT state FROM public.inbox_analysis_jobs WHERE inbox_item_id='${email}'`
          )
        ).rows
      ).toEqual([{ state: 'skipped' }]);
      await db.exec(
        `UPDATE public.inbox_analysis_jobs SET state='blocked',last_error='consent_required' WHERE inbox_item_id='${email}'; INSERT INTO public.ai_consent_decisions(user_id,scope,version,granted_at) VALUES ('${owner}','forwarded_email','external-ai-v1',now())`
      );
      expect(
        (
          await db.query(
            `SELECT state FROM public.inbox_analysis_jobs WHERE inbox_item_id='${email}'`
          )
        ).rows
      ).toEqual([{ state: 'blocked' }]);
    } finally {
      await db.close();
    }
  });
  it('never resets ready, running or failed jobs and keeps forwarded consent scoped', async () => {
    const db = await database();
    const email = '10000000-0000-4000-8000-000000000002';
    try {
      for (const [suffix, state] of [
        ['3', 'ready'],
        ['4', 'running'],
        ['5', 'failed']
      ] as const) {
        const id = `10000000-0000-4000-8000-00000000000${suffix}`;
        await db.exec(
          `INSERT INTO public.shortcut_inbox_items(id,user_id,source,received_at,raw_text,idempotency_key) VALUES ('${id}','${owner}','sms-shortcut',now(),'Synthetic capture ${suffix}',repeat('${suffix}',64)); UPDATE public.inbox_analysis_jobs SET state='${state}',attempts=2,last_error='consent_required',lease_token=${state === 'running' ? 'gen_random_uuid()' : 'null'},leased_until=${state === 'running' ? "now()+interval '2 minutes'" : 'null'} WHERE inbox_item_id='${id}'`
        );
      }
      await db.exec(
        `INSERT INTO public.shortcut_inbox_items(id,user_id,source,received_at,raw_text,idempotency_key) VALUES ('${email}','${owner}','forwarded_email',now(),'Synthetic forwarded capture',repeat('b',64)); UPDATE public.inbox_analysis_jobs SET state='blocked',last_error='consent_required' WHERE inbox_item_id='${email}'; INSERT INTO public.ai_consent_decisions(user_id,scope,version,granted_at) VALUES ('${owner}','financial_text','external-ai-v1',now())`
      );
      expect(
        (
          await db.query(
            'SELECT state,attempts FROM public.inbox_analysis_jobs ORDER BY inbox_item_id'
          )
        ).rows
      ).toEqual([
        { state: 'pending', attempts: 0 },
        { state: 'blocked', attempts: 0 },
        { state: 'ready', attempts: 2 },
        { state: 'running', attempts: 2 },
        { state: 'failed', attempts: 2 }
      ]);
      await db.exec(
        `INSERT INTO public.ai_consent_decisions(user_id,scope,version,granted_at) VALUES ('${owner}','forwarded_email','external-ai-v1',now())`
      );
      expect(
        (
          await db.query(
            `SELECT state FROM public.inbox_analysis_jobs WHERE inbox_item_id='${email}'`
          )
        ).rows
      ).toEqual([{ state: 'pending' }]);
      expect(
        (
          await db.query(
            `SELECT has_function_privilege('authenticated','public.resume_inbox_analysis_after_consent()','EXECUTE') AS consent,has_function_privilege('anon','public.resume_inbox_analysis_after_forwarding_verification()','EXECUTE') AS verification`
          )
        ).rows
      ).toEqual([{ consent: false, verification: false }]);
    } finally {
      await db.close();
    }
  });
  it('does not lose a consent grant that arrives before an older running worker reports its block', async () => {
    const db = await database();
    try {
      const lease = await claim(db);
      await db.exec(
        `INSERT INTO public.ai_consent_decisions(user_id,scope,version,granted_at) VALUES ('${owner}','financial_text','external-ai-v1',now())`
      );
      await service(
        db,
        `SELECT public.fail_inbox_analysis_job('${inbox}','${owner}','${lease}','consent_required',60,true)`
      );
      expect(
        (
          await db.query(
            'SELECT state,attempts,lease_token,last_error FROM public.inbox_analysis_jobs'
          )
        ).rows
      ).toEqual([{ state: 'pending', attempts: 0, lease_token: null, last_error: null }]);
    } finally {
      await db.close();
    }
  });
  it('does not lose verification completed while its capture worker is running', async () => {
    const db = await database();
    const email = '10000000-0000-4000-8000-000000000002';
    try {
      await db.exec(
        `INSERT INTO public.shortcut_inbox_items(id,user_id,source,received_at,raw_text,idempotency_key) VALUES ('${email}','${owner}','forwarded_email',now(),'Synthetic forwarded capture',repeat('b',64))`
      );
      const [lease] = await service<{ lease_token: string }>(
        db,
        `SELECT * FROM public.claim_inbox_analysis_jobs(1,'${email}','${owner}')`
      );
      await db.exec(
        `INSERT INTO public.email_forwarding_routes(user_id,address,confirmation_received_at,user_confirmed_at) VALUES ('${owner}','f-'||repeat('d',64)||'@example.com',now(),now())`
      );
      await service(
        db,
        `SELECT public.fail_inbox_analysis_job('${email}','${owner}','${lease!.lease_token}','unverified_source',60,true)`
      );
      expect(
        (
          await db.query(
            `SELECT state,attempts,lease_token,last_error FROM public.inbox_analysis_jobs WHERE inbox_item_id='${email}'`
          )
        ).rows
      ).toEqual([{ state: 'pending', attempts: 0, lease_token: null, last_error: null }]);
    } finally {
      await db.close();
    }
  });
  it('requeues ready jobs whose cached proposal was downgraded by an older client', async () => {
    const db = await database();
    try {
      const lease = await claim(db);
      await service(db, complete(lease));
      await db.exec('UPDATE public.forwarded_email_analyses SET analysis_version=2');
      expect(
        await service(
          db,
          `SELECT public.request_inbox_analysis_job('${inbox}','${owner}',false) AS state`
        )
      ).toEqual([{ state: 'pending' }]);
      expect((await db.query('SELECT attempts FROM public.inbox_analysis_jobs')).rows).toEqual([
        { attempts: 0 }
      ]);
    } finally {
      await db.close();
    }
  });
});
