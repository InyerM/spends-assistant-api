import { pathToFileURL } from 'node:url';
import { extractImageObservations } from '../../../src/ai/vision';
import { AiUsageMeter } from '../../../src/ai/usage-meter';
import { BenchmarkExtractionError, runBenchmark, type PageExtractor } from './benchmark';
import { SYNTHETIC_PAGES } from './fixture';
import type { RenderedPage } from './render';

export function parseBenchmarkArgs(
  args: string[],
  apiKey: string
): { live: boolean; escalateDensePage: boolean } {
  if (args.length === 0) return { live: false, escalateDensePage: false };
  if (args[0] !== '--live' || args.length > 2 || (args.length === 2 && args[1] !== '--escalate'))
    throw new Error('Only --live is supported; input is always synthetic');
  if (!apiKey) throw new Error('OpenRouter key required for --live');
  return { live: true, escalateDensePage: args[1] === '--escalate' };
}

export function shouldEscalatePage(pageNumber: number, escalateDensePage: boolean): boolean {
  return escalateDensePage && pageNumber === 4;
}

/** This offline oracle tests rendering, page binding, and scoring, not model quality. */
export async function oraclePage(page: RenderedPage) {
  const fixture = SYNTHETIC_PAGES.find((item) => item.pageNumber === page.pageNumber);
  if (!fixture) throw new Error('Unknown synthetic page');
  return {
    observations: fixture.rows.map((row) => ({
      amount: row.amount,
      currency: row.currency,
      occurred_at: row.date,
      description: row.description,
      counterparty: null,
      reference: row.reference,
      source_excerpt: row.reference,
      confidence: 1
    })),
    model: 'synthetic-oracle',
    usage: null
  };
}

/** The explicit escalation flag changes only the 15-row synthetic page. */
export function createLiveExtractor(
  apiKey: string,
  escalateDensePage: boolean,
  extract: typeof extractImageObservations = extractImageObservations
): PageExtractor {
  return async (page) => {
    const meter = new AiUsageMeter();
    try {
      const result = await extract({
        apiKey,
        imageDataUrl: `data:image/png;base64,${page.png.toString('base64')}`,
        escalate: shouldEscalatePage(page.pageNumber, escalateDensePage),
        meter
      });
      return { observations: result.draft.observations, model: result.model, usage: result.usage };
    } catch (error) {
      const usage = meter.summary();
      throw new BenchmarkExtractionError(
        error instanceof Error ? error.message : 'Extraction failed',
        {
          prompt_tokens: usage.inputTokens,
          completion_tokens: usage.outputTokens,
          cost: usage.estimatedCostMicros === null ? null : usage.estimatedCostMicros / 1_000_000
        }
      );
    }
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.OR_API_KEY || process.env.OPENROUTER_API_KEY || '';
  const { live, escalateDensePage } = parseBenchmarkArgs(process.argv.slice(2), apiKey);
  const extractor: PageExtractor = live
    ? createLiveExtractor(apiKey, escalateDensePage)
    : oraclePage;
  const result = await runBenchmark(extractor);
  process.stdout.write(
    `${JSON.stringify(
      {
        fixture: 'built-in-five-page-synthetic-statement',
        mode: live ? 'live-image-adapter' : 'offline-synthetic-oracle',
        modelAttempted: live,
        densePageEscalated: escalateDensePage,
        ...result
      },
      null,
      2
    )}\n`
  );
  if (live && !result.summary.pass) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Benchmark failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
