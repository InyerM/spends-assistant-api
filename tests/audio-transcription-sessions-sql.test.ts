import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
const owner = '11111111-1111-4111-8111-111111111111',
  session = '22222222-2222-4222-8222-222222222222';
async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);INSERT INTO auth.users VALUES('${owner}');CREATE TABLE public.test_quota(user_id uuid PRIMARY KEY,used integer DEFAULT 0);INSERT INTO public.test_quota VALUES('${owner}',0);
 CREATE FUNCTION public.reserve_ai_parse(p_user_id uuid) RETURNS TABLE(allowed boolean,used integer,"limit" integer) LANGUAGE plpgsql AS $$ BEGIN UPDATE public.test_quota q SET used=q.used+1 WHERE q.user_id=p_user_id AND q.used<1;RETURN QUERY SELECT FOUND,q.used,1 FROM public.test_quota q WHERE q.user_id=p_user_id;END $$;`);
  await db.exec(
    readFileSync(
      new URL(
        '../supabase/migrations/20261013000059_audio_transcription_sessions.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  return db;
}
it('charges one quota unit for four ordered updates and rejects replay, closure and a new exhausted session', async () => {
  const db = await database();
  try {
    for (let sequence = 0; sequence < 4; sequence++)
      expect(
        (
          await db.query<{ allowed: boolean; used: number }>(
            `SELECT * FROM public.reserve_audio_transcription($1,$2,$3,$4)`,
            [owner, session, sequence, sequence === 3]
          )
        ).rows[0]
      ).toMatchObject({ allowed: true, used: 1 });
    expect((await db.query('SELECT used FROM public.test_quota')).rows).toEqual([{ used: 1 }]);
    await expect(
      db.query(`SELECT * FROM public.reserve_audio_transcription($1,$2,3,true)`, [owner, session])
    ).rejects.toThrow('expired or out of sequence');
    expect(
      (
        await db.query<{ allowed: boolean }>(
          `SELECT * FROM public.reserve_audio_transcription($1,'33333333-3333-4333-8333-333333333333',0,true)`,
          [owner]
        )
      ).rows[0].allowed
    ).toBe(false);
  } finally {
    await db.close();
  }
});
it('rejects skips and expired sessions and grants no browser or anonymous access', async () => {
  const db = await database();
  try {
    await expect(
      db.query(`SELECT * FROM public.reserve_audio_transcription($1,$2,1,false)`, [owner, session])
    ).rejects.toThrow('begin at zero');
    await db.query(`SELECT * FROM public.reserve_audio_transcription($1,$2,0,false)`, [
      owner,
      session
    ]);
    await expect(
      db.query(`SELECT * FROM public.reserve_audio_transcription($1,$2,0,false)`, [owner, session])
    ).rejects.toThrow('out of sequence');
    await db.exec(
      `UPDATE public.audio_transcription_sessions SET expires_at=now()-interval '1 second';`
    );
    await expect(
      db.query(`SELECT * FROM public.reserve_audio_transcription($1,$2,1,true)`, [owner, session])
    ).rejects.toThrow('expired');
    expect(
      (
        await db.query(
          `SELECT has_function_privilege('anon','public.reserve_audio_transcription(uuid,uuid,integer,boolean)','EXECUTE') AS anon,has_function_privilege('authenticated','public.reserve_audio_transcription(uuid,uuid,integer,boolean)','EXECUTE') AS browser`
        )
      ).rows[0]
    ).toEqual({ anon: false, browser: false });
  } finally {
    await db.close();
  }
});
