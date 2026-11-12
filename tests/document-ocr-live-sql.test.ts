import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const doc = '33333333-3333-4333-8333-333333333333';
const claim = '44444444-4444-4444-8444-444444444444';
const sha = 'a'.repeat(64);
let db: PGlite;
const read = (file: string) =>
  readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE public.ai_consent_decisions(user_id uuid,scope text CONSTRAINT ai_consent_decisions_scope_check CHECK(scope IN ('financial_text','document_images','forwarded_email')),version text,granted_at timestamptz,revoked_at timestamptz);
    CREATE TABLE public.documents(id uuid PRIMARY KEY,user_id uuid,status text,processing_token uuid,document_type text,model text,error_code text);
    CREATE TABLE public.document_observations(id uuid DEFAULT gen_random_uuid(),document_id uuid,user_id uuid,ordinal integer,amount numeric,currency text,occurred_at_text text,description text,counterparty text,reference text,source_excerpt text,confidence numeric,status text DEFAULT 'pending',UNIQUE(document_id,ordinal));
    CREATE FUNCTION public.complete_document_extraction_server(uuid,uuid,uuid,text,text,jsonb) RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
    INSERT INTO auth.users VALUES('${owner}'),('${other}');
  `);
  await db.exec(read('20261112000000_document_ocr_budget.sql'));
  await db.exec(read('20261112000010_document_ocr_provenance.sql'));
}, 20000);
afterAll(async () => {
  await db?.close();
});

async function reset() {
  await db.exec(`TRUNCATE document_ocr_budget_reservations,document_observations,documents,ai_consent_decisions;
    INSERT INTO documents VALUES('${doc}','${owner}','processing','${claim}',NULL,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO ai_consent_decisions VALUES('${owner}','document_ocr','external-ai-v1',now(),NULL);`);
}
async function reserve(user = owner, token = claim, amount = 433527, limit = 5000000) {
  return db.query<{ id: string }>('SELECT reserve_document_ocr_budget($1,$2,$3,$4,$5) AS id', [
    user,
    doc,
    token,
    amount,
    limit
  ]);
}
const row = {
  ordinal: 0,
  amount: -5000,
  currency: 'COP',
  occurred_at_text: '2026-11-12',
  description: 'Synthetic lunch',
  source_excerpt: 'Lunch 5000',
  confidence: 0.9,
  source_page: 1
};
async function complete(
  rows: unknown[] = [row],
  ownerId = owner,
  token = claim,
  pageCount: number | null = 1,
  hash: string | null = sha,
  pathway: string | null = 'cloud-pdf-mistral-ocr'
) {
  return db.query('SELECT complete_document_extraction_server($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)', [
    doc,
    ownerId,
    token,
    'statement',
    'deepseek/deepseek-v4.1-flash',
    JSON.stringify(rows),
    pageCount,
    hash,
    pathway
  ]);
}

describe('document OCR migrations against PostgreSQL engine', () => {
  it('reserves conservatively, settles once, and prevents claim replay', async () => {
    await reset();
    const { rows } = await reserve();
    expect(
      (
        await db.query<{ cost: number }>(
          'SELECT charged_micros::integer AS cost FROM document_ocr_budget_reservations'
        )
      ).rows[0].cost
    ).toBe(433527);
    await expect(reserve()).rejects.toThrow();
    expect(
      (await db.query('SELECT settle_document_ocr_budget($1,1200) AS settled', [rows[0].id])).rows
    ).toEqual([{ settled: true }]);
    expect(
      (await db.query('SELECT settle_document_ocr_budget($1,0) AS settled', [rows[0].id])).rows
    ).toEqual([{ settled: false }]);
    expect(
      (
        await db.query(
          'SELECT charged_micros::integer AS cost FROM document_ocr_budget_reservations'
        )
      ).rows
    ).toEqual([{ cost: 1200 }]);
  });
  it('rejects foreign owner, stale claim, revoked consent, and exhausted budget', async () => {
    await reset();
    await expect(reserve(other)).rejects.toThrow('claim unavailable');
    await expect(reserve(owner, other)).rejects.toThrow('claim unavailable');
    await expect(reserve(owner, claim, 433527, 400000)).rejects.toThrow('budget exhausted');
    await db.exec('UPDATE ai_consent_decisions SET revoked_at=now(),granted_at=NULL');
    await expect(reserve()).rejects.toThrow('consent required');
    expect(
      (await db.query('SELECT count(*)::integer AS count FROM document_ocr_budget_reservations'))
        .rows
    ).toEqual([{ count: 0 }]);
  });
  it('retains reservation when provider cost is unknown', async () => {
    await reset();
    const { rows } = await reserve();
    await db.query('SELECT settle_document_ocr_budget($1,NULL)', [rows[0].id]);
    expect(
      (
        await db.query(
          'SELECT charged_micros::integer AS cost FROM document_ocr_budget_reservations'
        )
      ).rows
    ).toEqual([{ cost: 433527 }]);
  });
  it('preserves spent budget when the source document is deleted', async () => {
    await reset();
    await reserve();
    await db.query('DELETE FROM documents WHERE id=$1', [doc]);
    expect(
      (
        await db.query(
          'SELECT document_id,charged_micros::integer AS cost FROM document_ocr_budget_reservations'
        )
      ).rows
    ).toEqual([{ document_id: null, cost: 433527 }]);
  });
  it('denies client roles all budget and extraction commands', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect(
        (
          await db.query('SELECT has_function_privilege($1, $2, $3) AS permitted', [
            role,
            'public.reserve_document_ocr_budget(uuid,uuid,uuid,bigint,bigint)',
            'EXECUTE'
          ])
        ).rows
      ).toEqual([{ permitted: false }]);
      expect(
        (
          await db.query('SELECT has_function_privilege($1, $2, $3) AS permitted', [
            role,
            'public.complete_document_extraction_server(uuid,uuid,uuid,text,text,jsonb,integer,text,text)',
            'EXECUTE'
          ])
        ).rows
      ).toEqual([{ permitted: false }]);
      expect(
        (
          await db.query('SELECT has_table_privilege($1,$2,$3) AS permitted', [
            role,
            'document_ocr_budget_reservations',
            'SELECT'
          ])
        ).rows
      ).toEqual([{ permitted: false }]);
    }
  });
  it('persists source page and document provenance without posting', async () => {
    await reset();
    await complete();
    expect(
      (
        await db.query(
          'SELECT status,processing_token,extraction_page_count,extraction_source_sha256,extraction_pathway FROM documents'
        )
      ).rows
    ).toEqual([
      {
        status: 'extracted',
        processing_token: null,
        extraction_page_count: 1,
        extraction_source_sha256: sha,
        extraction_pathway: 'cloud-pdf-mistral-ocr'
      }
    ]);
    expect((await db.query('SELECT source_page,status FROM document_observations')).rows).toEqual([
      { source_page: 1, status: 'pending' }
    ]);
    await expect(complete()).rejects.toThrow('not claimed');
  });
  it('rejects foreign ownership, out-of-range pages, and reviewed overwrite atomically', async () => {
    await reset();
    await expect(complete([row], other)).rejects.toThrow('not claimed');
    await expect(complete([{ ...row, source_page: 2 }])).rejects.toThrow('provenance');
    await db.query(
      'INSERT INTO document_observations(document_id,user_id,ordinal,status) VALUES($1,$2,0,$3)',
      [doc, owner, 'confirmed']
    );
    await expect(complete()).rejects.toThrow('cannot be overwritten');
    expect((await db.query('SELECT status FROM document_observations')).rows).toEqual([
      { status: 'confirmed' }
    ]);
    expect((await db.query('SELECT status FROM documents')).rows).toEqual([
      { status: 'processing' }
    ]);
  });
  it('keeps six-argument legacy extraction compatible', async () => {
    await reset();
    const legacyRow = Object.fromEntries(
      Object.entries(row).filter(([key]) => key !== 'source_page')
    );
    await db.query('SELECT complete_document_extraction_server($1,$2,$3,$4,$5,$6::jsonb)', [
      doc,
      owner,
      claim,
      'statement',
      'local-text',
      JSON.stringify([legacyRow])
    ]);
    expect((await db.query('SELECT source_page FROM document_observations')).rows).toEqual([
      { source_page: null }
    ]);
  });
});
