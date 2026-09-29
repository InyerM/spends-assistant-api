import { buildSyntheticStatementPdf, SYNTHETIC_PAGES, type SyntheticPage } from './fixture';
import { renderSyntheticPages, type RenderedPage } from './render';

export interface Observation {
  amount: number | null;
  currency: string | null;
  occurred_at: string | null;
  description: string;
  counterparty: string | null;
  reference: string | null;
  source_excerpt: string;
  confidence: number;
}
interface ExtractionResult {
  observations: Observation[];
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number; cost: number | null } | null;
}
export type PageExtractor = (page: RenderedPage) => Promise<ExtractionResult>;
export interface PageOutput {
  pageNumber: number;
  observations: Observation[];
}

interface FailureUsage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost: number | null;
}

export class BenchmarkExtractionError extends Error {
  readonly usage: FailureUsage;

  constructor(message: string, usage: FailureUsage) {
    super(message);
    this.usage = usage;
  }
}

export function scorePageOutputs(expectedPages: SyntheticPage[], outputs: PageOutput[]) {
  const expectedRows = expectedPages.flatMap((page) =>
    page.rows.map((row) => ({ ...row, pageNumber: page.pageNumber }))
  );
  const matched = new Set<string>();
  let falseRows = 0;
  let wrongPageRows = 0;
  for (const output of outputs) {
    for (const observation of output.observations) {
      const row = expectedRows.find(
        (candidate) =>
          observation.reference === candidate.reference ||
          observation.source_excerpt.includes(candidate.reference)
      );
      if (
        !row ||
        row.pageNumber !== output.pageNumber ||
        observation.amount !== row.amount ||
        observation.currency !== row.currency ||
        observation.occurred_at?.slice(0, 10) !== row.date ||
        matched.has(row.reference)
      ) {
        falseRows++;
        if (row && row.pageNumber !== output.pageNumber) wrongPageRows++;
        continue;
      }
      matched.add(row.reference);
    }
  }
  const pagesAccountedFor = new Set(outputs.map((output) => output.pageNumber)).size;
  const missedRows = expectedRows.length - matched.size;
  return {
    expectedRows: expectedRows.length,
    matchedRows: matched.size,
    missedRows,
    falseRows,
    wrongPageRows,
    pagesAccountedFor,
    pass: pagesAccountedFor === expectedPages.length && missedRows === 0 && falseRows === 0
  };
}

function safeError(error: unknown): string {
  return error instanceof Error && error.message === 'Vision response truncated'
    ? 'Vision response truncated'
    : 'Extraction failed';
}

export async function runBenchmark(extract: PageExtractor) {
  const pdf = buildSyntheticStatementPdf();
  const renderStart = performance.now();
  const pages = await renderSyntheticPages(pdf);
  const render = {
    pageCount: pages.length,
    pdfBytes: pdf.length,
    totalPngBytes: pages.reduce((sum, page) => sum + page.png.length, 0),
    durationMs: Math.round(performance.now() - renderStart)
  };
  const outputs: PageOutput[] = [];
  const pageResults: Array<{
    pageNumber: number;
    pngBytes: number;
    observationCount: number;
    model: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    costUsd: number | null;
    latencyMs: number;
    error: string | null;
  }> = [];
  for (const page of pages) {
    const start = performance.now();
    try {
      const result = await extract(page);
      outputs.push({ pageNumber: page.pageNumber, observations: result.observations });
      pageResults.push({
        pageNumber: page.pageNumber,
        pngBytes: page.png.length,
        observationCount: result.observations.length,
        model: result.model,
        promptTokens: result.usage?.prompt_tokens ?? null,
        completionTokens: result.usage?.completion_tokens ?? null,
        costUsd: result.usage?.cost ?? null,
        latencyMs: Math.round(performance.now() - start),
        error: null
      });
    } catch (error) {
      const usage = error instanceof BenchmarkExtractionError ? error.usage : null;
      pageResults.push({
        pageNumber: page.pageNumber,
        pngBytes: page.png.length,
        observationCount: 0,
        model: null,
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
        costUsd: usage?.cost ?? null,
        latencyMs: Math.round(performance.now() - start),
        error: safeError(error)
      });
    }
  }
  const score = scorePageOutputs(SYNTHETIC_PAGES, outputs);
  const knownCostUsd =
    Math.round(pageResults.reduce((sum, page) => sum + (page.costUsd ?? 0), 0) * 1e9) / 1e9;
  return {
    render,
    pageResults,
    summary: {
      ...score,
      knownCostUsd,
      totalCostComplete: pageResults.every((page) => page.costUsd !== null)
    }
  };
}
