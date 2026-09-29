import { pathToFileURL } from 'node:url';
import { extractImageObservations } from '../../../src/ai/vision';
import { AiUsageMeter } from '../../../src/ai/usage-meter';
import { BenchmarkExtractionError, runBenchmark, type PageExtractor } from './benchmark';
import { SYNTHETIC_PAGES } from './fixture';
import type { RenderedPage, RenderedTile } from './render';
import { runTiledBenchmark } from './tiles';

export function parseBenchmarkArgs(
  args: string[],
  apiKey: string
): { live: boolean; escalateDensePage: boolean; tileDensePage: boolean } {
  if (args.length === 0) return { live: false, escalateDensePage: false, tileDensePage: false };
  if (args.includes('--escalate') && args.includes('--tile'))
    throw new Error('--escalate and --tile cannot be combined');
  const valid =
    (args.length === 1 && (args[0] === '--live' || args[0] === '--tile')) ||
    (args.length === 2 &&
      args[0] === '--live' &&
      (args[1] === '--escalate' || args[1] === '--tile'));
  if (!valid) throw new Error('Only --live is supported; input is always synthetic');
  const live = args.includes('--live');
  if (live && !apiKey) throw new Error('OpenRouter key required for --live');
  return {
    live,
    escalateDensePage: args.includes('--escalate'),
    tileDensePage: args.includes('--tile')
  };
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

export async function oracleTile(tile: RenderedTile) {
  const page = await oraclePage(tile);
  return {
    ...page,
    observations: page.observations.filter((observation) =>
      tile.expectedReferences.includes(observation.reference)
    )
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
  const { live, escalateDensePage, tileDensePage } = parseBenchmarkArgs(
    process.argv.slice(2),
    apiKey
  );
  const extractor: PageExtractor = live
    ? createLiveExtractor(apiKey, escalateDensePage)
    : oraclePage;
  const result = tileDensePage
    ? await runTiledBenchmark(extractor, live ? createLiveExtractor(apiKey, false) : oracleTile)
    : await runBenchmark(extractor);
  process.stdout.write(
    `${JSON.stringify(
      {
        fixture: 'built-in-five-page-synthetic-statement',
        mode: live ? 'live-image-adapter' : 'offline-synthetic-oracle',
        modelAttempted: live,
        densePageEscalated: escalateDensePage,
        densePageTiled: tileDensePage,
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
