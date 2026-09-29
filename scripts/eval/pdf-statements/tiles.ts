import { performance } from 'node:perf_hooks';
import {
  BenchmarkExtractionError,
  safeError,
  scorePageOutputs,
  type ExtractionResult,
  type Observation,
  type PageExtractor,
  type PageOutput
} from './benchmark';
import { buildSyntheticStatementPdf, SYNTHETIC_PAGES, type SyntheticPage } from './fixture';
import {
  renderSyntheticDenseTiles,
  renderSyntheticFinalTile,
  renderSyntheticPages,
  SYNTHETIC_FINAL_TILE_SPEC,
  SYNTHETIC_TILE_SPECS,
  type RenderedTile
} from './render';

export interface TileOutput {
  pageNumber: number;
  tileNumber: number;
  observations: Observation[];
}
export type TileExtractor = (tile: RenderedTile) => Promise<ExtractionResult>;

function fixtureRow(reference: string, pages: SyntheticPage[]) {
  for (const page of pages) {
    const row = page.rows.find((candidate) => candidate.reference === reference);
    if (row) return { ...row, pageNumber: page.pageNumber };
  }
  return null;
}

export function scoreTiledOutputs(
  expectedPages: SyntheticPage[],
  pageOutputs: PageOutput[],
  tileOutputs: TileOutput[],
  focusFinalPage = false
) {
  const specs = focusFinalPage
    ? [...SYNTHETIC_TILE_SPECS, SYNTHETIC_FINAL_TILE_SPEC]
    : [...SYNTHETIC_TILE_SPECS];
  const seen = new Map<
    string,
    { pageNumber: number; observation: Observation; tileNumbers: number[] }
  >();
  let tileFalseRows = 0;
  let wrongTileRows = 0;
  for (const tile of tileOutputs) {
    const spec = specs.find((candidate) => candidate.tileNumber === tile.tileNumber);
    for (const observation of tile.observations) {
      const excerptMatches = expectedPages
        .flatMap((page) => page.rows)
        .filter((row) => observation.source_excerpt.includes(row.reference));
      const reference =
        observation.reference ??
        (excerptMatches.length === 1 ? excerptMatches[0].reference : undefined);
      const row = reference ? fixtureRow(reference, expectedPages) : null;
      if (
        !spec ||
        tile.pageNumber !== spec.pageNumber ||
        !reference ||
        !row ||
        row.pageNumber !== spec.pageNumber ||
        !spec.expectedReferences.some((expected) => expected === reference)
      ) {
        tileFalseRows++;
        if (row) wrongTileRows++;
        continue;
      }
      if (
        observation.amount !== row.amount ||
        observation.currency !== row.currency ||
        observation.occurred_at?.slice(0, 10) !== row.date
      ) {
        tileFalseRows++;
        continue;
      }
      const prior = seen.get(reference);
      if (prior) {
        if (prior.tileNumbers.includes(tile.tileNumber)) {
          tileFalseRows++;
          continue;
        }
        prior.tileNumbers.push(tile.tileNumber);
      } else {
        seen.set(reference, {
          pageNumber: tile.pageNumber,
          observation,
          tileNumbers: [tile.tileNumber]
        });
      }
    }
  }
  const tiledPages = [...new Set(specs.map((spec) => spec.pageNumber))];
  const base = scorePageOutputs(expectedPages, [
    ...pageOutputs,
    ...tiledPages
      .filter((pageNumber) => tileOutputs.some((output) => output.pageNumber === pageNumber))
      .map((pageNumber) => ({
        pageNumber,
        observations: [...seen.values()]
          .filter((value) => value.pageNumber === pageNumber)
          .map((value) => value.observation)
      }))
  ]);
  const rowAttribution = [...seen.entries()]
    .map(([reference, value]) => ({
      reference,
      pageNumber: value.pageNumber,
      tileNumbers: [...value.tileNumbers].sort((a, b) => a - b)
    }))
    .sort((a, b) => a.reference.localeCompare(b.reference));
  const overlapDuplicates = rowAttribution.filter((row) => row.tileNumbers.length > 1);
  const tilesAccountedFor = new Set(tileOutputs.map((tile) => tile.tileNumber)).size;
  return {
    ...base,
    falseRows: base.falseRows + tileFalseRows,
    wrongTileRows,
    tilesAccountedFor,
    overlapDuplicates,
    rowAttribution,
    pass: base.pass && tileFalseRows === 0 && tilesAccountedFor === specs.length
  };
}

interface ResultRow {
  pageNumber: number;
  tileNumber?: number;
  cropY?: number;
  cropHeight?: number;
  pngBytes: number;
  observationCount: number;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  latencyMs: number;
  error: string | null;
}

async function extractOne<T extends { pageNumber: number; png: Buffer }>(
  input: T,
  extract: (input: T) => Promise<ExtractionResult>
): Promise<{ row: ResultRow; output: Observation[] | null }> {
  const start = performance.now();
  try {
    const result = await extract(input);
    return {
      row: {
        pageNumber: input.pageNumber,
        pngBytes: input.png.length,
        observationCount: result.observations.length,
        model: result.model,
        promptTokens: result.usage?.prompt_tokens ?? null,
        completionTokens: result.usage?.completion_tokens ?? null,
        costUsd: result.usage?.cost ?? null,
        latencyMs: Math.round(performance.now() - start),
        error: null
      },
      output: result.observations
    };
  } catch (error) {
    const usage = error instanceof BenchmarkExtractionError ? error.usage : null;
    return {
      row: {
        pageNumber: input.pageNumber,
        pngBytes: input.png.length,
        observationCount: 0,
        model: null,
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
        costUsd: usage?.cost ?? null,
        latencyMs: Math.round(performance.now() - start),
        error: safeError(error)
      },
      output: null
    };
  }
}

/** A tile failure blocks the score even when overlap covers every row. */
export async function runTiledBenchmark(
  extractPage: PageExtractor,
  extractTile: TileExtractor,
  options: { focusFinalPage?: boolean } = {}
) {
  const pdf = buildSyntheticStatementPdf();
  const renderStart = performance.now();
  const [pages, denseTiles, finalTile] = await Promise.all([
    renderSyntheticPages(pdf),
    renderSyntheticDenseTiles(pdf),
    options.focusFinalPage ? renderSyntheticFinalTile(pdf) : Promise.resolve(null)
  ]);
  const tiles = finalTile ? [...denseTiles, finalTile] : denseTiles;
  const render = {
    pageCount: pages.length,
    tileCount: tiles.length,
    pdfBytes: pdf.length,
    sentPngBytes:
      pages
        .filter((page) => page.pageNumber !== 4 && (!finalTile || page.pageNumber !== 5))
        .reduce((sum, page) => sum + page.png.length, 0) +
      tiles.reduce((sum, tile) => sum + tile.png.length, 0),
    durationMs: Math.round(performance.now() - renderStart)
  };
  const pageOutputs: PageOutput[] = [];
  const tileOutputs: TileOutput[] = [];
  const pageResults: ResultRow[] = [];
  const tileResults: ResultRow[] = [];
  for (const page of pages) {
    if (page.pageNumber === 4 || (finalTile && page.pageNumber === 5)) continue;
    const result = await extractOne(page, extractPage);
    pageResults.push(result.row);
    if (result.output)
      pageOutputs.push({ pageNumber: page.pageNumber, observations: result.output });
  }
  for (const tile of tiles) {
    const result = await extractOne(tile, extractTile);
    tileResults.push({
      ...result.row,
      tileNumber: tile.tileNumber,
      cropY: tile.y,
      cropHeight: tile.height
    });
    if (result.output)
      tileOutputs.push({
        pageNumber: tile.pageNumber,
        tileNumber: tile.tileNumber,
        observations: result.output
      });
  }
  const score = scoreTiledOutputs(SYNTHETIC_PAGES, pageOutputs, tileOutputs, Boolean(finalTile));
  const results = [...pageResults, ...tileResults];
  const knownCostUsd =
    Math.round(results.reduce((sum, row) => sum + (row.costUsd ?? 0), 0) * 1e9) / 1e9;
  return {
    render,
    pageResults,
    tileResults,
    summary: {
      ...score,
      knownCostUsd,
      totalCostComplete: results.every((row) => row.costUsd !== null)
    }
  };
}
