import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  buildSyntheticStatementPdf,
  SYNTHETIC_PAGES
} from '../../../scripts/eval/pdf-statements/fixture';
import { renderSyntheticPages } from '../../../scripts/eval/pdf-statements/render';
import {
  BenchmarkExtractionError,
  runBenchmark,
  scorePageOutputs
} from '../../../scripts/eval/pdf-statements/benchmark';
import { oraclePage, parseBenchmarkArgs } from '../../../scripts/eval/pdf-statements/run';

const observation = (reference: string, amount: number, date: string) => ({
  amount,
  currency: 'COP',
  occurred_at: date,
  description: 'Synthetic transaction',
  counterparty: null,
  reference,
  source_excerpt: reference,
  confidence: 1
});

describe('synthetic PDF statement benchmark', () => {
  it('renders every generated page separately with bounded PNG output', async () => {
    const pdf = buildSyntheticStatementPdf();
    expect(pdf.subarray(0, 8).toString()).toBe('%PDF-1.4');
    const pages = await renderSyntheticPages(pdf);
    expect(pages.map((page) => page.pageNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(
      pages.every((page) =>
        page.png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
    ).toBe(true);
    expect(pages.every((page) => page.png.length > 0 && page.png.length <= 5 * 1024 * 1024)).toBe(
      true
    );
  });

  it('puts each expected reference on exactly its numbered PDF page', () => {
    const pdf = buildSyntheticStatementPdf();
    for (const page of SYNTHETIC_PAGES) {
      const text = execFileSync(
        'pdftotext',
        ['-f', String(page.pageNumber), '-l', String(page.pageNumber), '-layout', '-', '-'],
        { input: pdf, timeout: 10_000 }
      ).toString();
      expect(text).toContain(`PAGE ${page.pageNumber} OF ${SYNTHETIC_PAGES.length}`);
      for (const expected of SYNTHETIC_PAGES) {
        for (const row of expected.rows) {
          expect(text.includes(row.reference)).toBe(expected.pageNumber === page.pageNumber);
        }
      }
    }
  });

  it('accepts only its fixed synthetic PDF and explicit live mode', async () => {
    await expect(renderSyntheticPages(Buffer.from('%PDF-1.4\nprivate'))).rejects.toThrow(
      'Only the built-in synthetic PDF'
    );
    expect(parseBenchmarkArgs([], '')).toEqual({ live: false });
    expect(() => parseBenchmarkArgs(['--live'], '')).toThrow('OpenRouter key required');
    expect(() => parseBenchmarkArgs(['private.pdf'], 'key')).toThrow('Only --live is supported');
    expect(parseBenchmarkArgs(['--live'], 'key')).toEqual({ live: true });
  });

  it('labels the offline oracle as a plumbing check rather than model evidence', async () => {
    const result = await runBenchmark(oraclePage);
    expect(result.summary).toMatchObject({
      pass: true,
      matchedRows: 21,
      pagesAccountedFor: 5,
      knownCostUsd: 0,
      totalCostComplete: false
    });
    expect(result.pageResults.every((page) => page.model === 'synthetic-oracle')).toBe(true);
    expect(result.render).toMatchObject({ pageCount: 5 });
    expect(result.render.pdfBytes).toBeGreaterThan(0);
    expect(result.render.totalPngBytes).toBeGreaterThan(0);
    expect(result.render.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.pageResults.every((page) => page.pngBytes > 0)).toBe(true);
  });

  it('scores exact rows and detects a row attributed to the wrong page', () => {
    const outputs = SYNTHETIC_PAGES.map((page) => ({
      pageNumber: page.pageNumber,
      observations: page.rows.map((row) => observation(row.reference, row.amount, row.date))
    }));
    outputs[1].observations.push(observation('REF-101', 12345, '2026-09-01'));
    const score = scorePageOutputs(SYNTHETIC_PAGES, outputs);
    expect(score).toMatchObject({
      expectedRows: 21,
      matchedRows: 21,
      missedRows: 0,
      falseRows: 1,
      wrongPageRows: 1,
      pagesAccountedFor: 5
    });
    expect(score.pass).toBe(false);
  });

  it('fails closed on a truncated page and keeps missing cost unknown', async () => {
    const result = await runBenchmark(async (page) => {
      if (page.pageNumber === 2) throw new Error('Vision response truncated');
      return {
        observations: [],
        model: 'offline-test',
        usage:
          page.pageNumber === 1 ? { prompt_tokens: 20, completion_tokens: 10, cost: 0.001 } : null
      };
    });
    expect(result.pageResults).toHaveLength(5);
    expect(result.pageResults[1]).toMatchObject({
      pageNumber: 2,
      error: 'Vision response truncated'
    });
    expect(result.summary).toMatchObject({
      pass: false,
      pagesAccountedFor: 4,
      knownCostUsd: 0.001,
      totalCostComplete: false
    });
    expect(JSON.stringify(result)).not.toContain('data:image');
  });

  it('retains billed usage when a model response is truncated', async () => {
    const result = await runBenchmark(async (page) => {
      if (page.pageNumber === 4)
        throw new BenchmarkExtractionError('Vision response truncated', {
          prompt_tokens: 1200,
          completion_tokens: 2048,
          cost: 0.002
        });
      return {
        observations: [],
        model: 'offline-test',
        usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0.001 }
      };
    });
    expect(result.pageResults[3]).toMatchObject({
      error: 'Vision response truncated',
      promptTokens: 1200,
      completionTokens: 2048,
      costUsd: 0.002
    });
    expect(result.summary).toMatchObject({
      pass: false,
      knownCostUsd: 0.006,
      totalCostComplete: true
    });
  });
});
