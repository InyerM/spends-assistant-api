import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { config } from 'dotenv';
import { extractCloudPdfDraft } from '../../../src/ai/cloud-pdf-ocr';
import { HARD_CASES } from './hard-scans-fixtures';

/** Fixed synthetic release probe; cannot accept user files or private statement paths. */
async function main() {
  if (process.argv.slice(2).some((arg) => arg !== '--live'))
    throw new Error('Built-in fixtures only');
  const pdf = await readFile('/tmp/spends-hard-synthetic-scans/hard-scans.pdf');
  const prior = JSON.parse(
    await readFile('docs/evaluations/2026-11-11-hard-scans-plugin.json', 'utf8')
  );
  const sha256 = createHash('sha256').update(pdf).digest('hex');
  if (sha256 !== prior.pdfSha256) throw new Error('Synthetic PDF hash mismatch');
  const requireWeb = createRequire(
    new URL('../../../../spends-assistant-web/package.json', import.meta.url)
  );
  const { PDFDocument } = requireWeb('pdf-lib');
  const original = await PDFDocument.load(pdf);
  if (original.getPageCount() !== HARD_CASES.length)
    throw new Error('Synthetic page count mismatch');
  const pages: Uint8Array[] = [];
  for (let i = 0; i < HARD_CASES.length; i++) {
    const pagePdf = await PDFDocument.create();
    const [page] = await pagePdf.copyPages(original, [i]);
    pagePdf.addPage(page);
    const bytes = await pagePdf.save({ useObjectStreams: false });
    if (bytes.length > 1048576) throw new Error('Synthetic page exceeds route limit');
    pages.push(bytes);
  }
  if (!process.argv.includes('--live')) {
    console.log('Verified three immutable synthetic pages; no inference sent');
    return;
  }
  config({ path: '.env.local', quiet: true });
  const key = process.env.OR_API_KEY ?? process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('Missing local model credential');
  const results = [];
  for (let i = 0; i < pages.length; i++) {
    const bytes = pages[i];
    const startedAt = performance.now();
    const result = await extractCloudPdfDraft({
      cloudPdfOptIn: true,
      apiKey: key,
      pdfBytes: bytes,
      trustedInspection: {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        pageCount: 1,
        encrypted: false
      },
      budgetRemainingUsd: 0.433527
    });
    const expected = HARD_CASES[i].rows;
    const actual = result.draft.observations;
    const correct = expected.filter((row) =>
      actual.some(
        (value) =>
          value.reference === row.reference &&
          value.currency === row.currency &&
          value.occurred_at === row.date &&
          value.amount === Math.abs(row.amount) * (row.direction === 'debit' ? -1 : 1) &&
          value.direction === (row.direction === 'debit' ? 'outgoing' : 'incoming')
      )
    ).length;
    results.push({
      fixture: HARD_CASES[i].id,
      sourceSha256: createHash('sha256').update(bytes).digest('hex'),
      expectedRows: expected.length,
      actualRows: actual.length,
      exactNormalizedRows: correct,
      duplicateReferences: actual.length - new Set(actual.map((row) => row.reference)).size,
      documentType: result.draft.document_type,
      strictJson: result.strictJson,
      requiresReview: result.requiresReview,
      reservedUsd: result.reservedUsd,
      usage: result.usage,
      durationMs: Math.round(performance.now() - startedAt),
      observations: actual
    });
  }
  const report = {
    runAt: new Date().toISOString(),
    syntheticOnly: true,
    originalSha256: sha256,
    model: 'deepseek/deepseek-v4.1-flash',
    pathway: 'mistral-ocr-per-page-production-adapter',
    scope:
      'Real adapter on immutable synthetic split pages, not a live database/HTTP end-to-end test',
    results
  };
  await writeFile(
    'docs/evaluations/2026-11-12-ocr-release.json',
    JSON.stringify(report, null, 2) + '\n'
  );
  console.log(
    JSON.stringify({
      pages: results.length,
      correct: results.reduce((n, r) => n + r.exactNormalizedRows, 0),
      expected: results.reduce((n, r) => n + r.expectedRows, 0),
      reportedCostUsd: results.reduce((n, r) => n + (r.usage?.cost ?? 0), 0),
      allCostsKnown: results.every((r) => r.usage?.cost != null)
    })
  );
}
main().catch(() => {
  console.error('Synthetic OCR release probe failed; no provider bodies logged');
  process.exitCode = 1;
});
