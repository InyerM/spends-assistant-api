import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  buildSyntheticStatementPdf,
  SYNTHETIC_PAGES
} from '../../../scripts/eval/pdf-statements/fixture';
import {
  renderSyntheticDenseTiles,
  SYNTHETIC_TILE_SPECS
} from '../../../scripts/eval/pdf-statements/render';
import { oraclePage, oracleTile } from '../../../scripts/eval/pdf-statements/run';
import { runTiledBenchmark, scoreTiledOutputs } from '../../../scripts/eval/pdf-statements/tiles';

const rowObservation = (reference: string) => {
  const row = SYNTHETIC_PAGES[3].rows.find((item) => item.reference === reference);
  if (!row) throw new Error('Unknown fixture row');
  return {
    amount: row.amount,
    currency: row.currency,
    occurred_at: row.date,
    description: row.description,
    counterparty: null,
    reference,
    source_excerpt: reference,
    confidence: 1
  };
};
const pageOutputs = SYNTHETIC_PAGES.filter((page) => page.pageNumber !== 4).map((page) => ({
  pageNumber: page.pageNumber,
  observations: page.rows.map((row) => ({
    amount: row.amount,
    currency: row.currency,
    occurred_at: row.date,
    description: row.description,
    counterparty: null,
    reference: row.reference,
    source_excerpt: row.reference,
    confidence: 1
  }))
}));
const tileOutputs = () =>
  SYNTHETIC_TILE_SPECS.map((tile) => ({
    pageNumber: 4,
    tileNumber: tile.tileNumber,
    observations: tile.expectedReferences.map(rowObservation)
  }));

describe('synthetic dense-page tiling', () => {
  it('renders three bounded crops whose overlap matches the physical fixture rows', async () => {
    const pdf = buildSyntheticStatementPdf();
    const tiles = await renderSyntheticDenseTiles(pdf);
    expect(tiles.map((tile) => [tile.pageNumber, tile.tileNumber])).toEqual([
      [4, 1],
      [4, 2],
      [4, 3]
    ]);
    expect(tiles.every((tile) => tile.png.length > 0 && tile.png.length <= 5 * 1024 * 1024)).toBe(
      true
    );
    for (const tile of tiles) {
      expect(tile.png.readUInt32BE(16)).toBe(935);
      expect(tile.png.readUInt32BE(20)).toBe(tile.height);
    }
    const bbox = execFileSync('pdftotext', ['-f', '4', '-l', '4', '-bbox', '-', '-'], {
      input: pdf,
      timeout: 10_000
    }).toString();
    for (const tile of SYNTHETIC_TILE_SPECS) {
      const references = [
        ...bbox.matchAll(
          /<word[^>]*yMin="([0-9.]+)"[^>]*yMax="([0-9.]+)"[^>]*>(REF-4\d\d)<\/word>/g
        )
      ];
      const physicallyContained = references
        .filter(
          (match) =>
            (Number(match[1]) * 110) / 72 >= tile.y &&
            (Number(match[2]) * 110) / 72 <= tile.y + tile.height
        )
        .map((match) => match[3]);
      expect(physicallyContained).toEqual(tile.expectedReferences);
      for (const match of references) {
        const top = (Number(match[1]) * 110) / 72;
        const bottom = (Number(match[2]) * 110) / 72;
        const intersects = top < tile.y + tile.height && bottom > tile.y;
        const contained = top >= tile.y && bottom <= tile.y + tile.height;
        expect(intersects && !contained, `tile ${tile.tileNumber} clips ${match[3]}`).toBe(false);
      }
    }
  });

  it('reports overlap duplicates with page and tile provenance without losing rows', () => {
    const score = scoreTiledOutputs(SYNTHETIC_PAGES, pageOutputs, tileOutputs());
    expect(score).toMatchObject({
      pass: true,
      expectedRows: 21,
      matchedRows: 21,
      tilesAccountedFor: 3,
      falseRows: 0,
      wrongTileRows: 0
    });
    expect(score.overlapDuplicates).toEqual([
      { reference: 'REF-405', pageNumber: 4, tileNumbers: [1, 2] },
      { reference: 'REF-412', pageNumber: 4, tileNumbers: [2, 3] }
    ]);
    expect(score.rowAttribution.find((row) => row.reference === 'REF-405')).toEqual({
      reference: 'REF-405',
      pageNumber: 4,
      tileNumbers: [1, 2]
    });
  });

  it('fails on an out-of-tile row or missing tile', () => {
    const misplaced = tileOutputs();
    misplaced[0].observations.push(rowObservation('REF-415'));
    expect(scoreTiledOutputs(SYNTHETIC_PAGES, pageOutputs, misplaced)).toMatchObject({
      pass: false,
      wrongTileRows: 1
    });
    expect(
      scoreTiledOutputs(SYNTHETIC_PAGES, pageOutputs, tileOutputs().slice(0, 2))
    ).toMatchObject({
      pass: false,
      tilesAccountedFor: 2
    });
  });

  it('flags conflicting or repeated overlap evidence instead of silently merging it', () => {
    const contradictory = tileOutputs();
    contradictory[1].observations[0] = {
      ...rowObservation('REF-405'),
      reference: 'REF-415',
      source_excerpt: 'REF-405'
    };
    expect(scoreTiledOutputs(SYNTHETIC_PAGES, pageOutputs, contradictory)).toMatchObject({
      pass: false,
      wrongTileRows: 1
    });
    const repeated = tileOutputs();
    repeated[0].observations.push(rowObservation('REF-405'));
    expect(scoreTiledOutputs(SYNTHETIC_PAGES, pageOutputs, repeated)).toMatchObject({
      pass: false,
      falseRows: 1
    });
  });

  it('fails closed when one tile truncates and keeps its failure visible', async () => {
    const result = await runTiledBenchmark(oraclePage, async (tile) => {
      if (tile.tileNumber === 2) throw new Error('Vision response truncated');
      return oracleTile(tile);
    });
    expect(result.summary.pass).toBe(false);
    expect(result.tileResults[1]).toMatchObject({
      pageNumber: 4,
      tileNumber: 2,
      error: 'Vision response truncated'
    });
    expect(result.summary.tilesAccountedFor).toBe(2);
    expect(result.summary.totalCostComplete).toBe(false);
  });
});
