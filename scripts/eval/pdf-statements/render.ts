import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildSyntheticStatementPdf, SYNTHETIC_PAGES } from './fixture';

const exec = promisify(execFile);
const MAX_PNG_BYTES = 5 * 1024 * 1024;
export interface RenderedPage {
  pageNumber: number;
  png: Buffer;
}

export const SYNTHETIC_TILE_SPECS = [
  {
    pageNumber: 4,
    tileNumber: 1,
    y: 0,
    height: 265,
    expectedReferences: ['REF-401', 'REF-402', 'REF-403', 'REF-404', 'REF-405']
  },
  {
    pageNumber: 4,
    tileNumber: 2,
    y: 235,
    height: 245,
    expectedReferences: [
      'REF-405',
      'REF-406',
      'REF-407',
      'REF-408',
      'REF-409',
      'REF-410',
      'REF-411',
      'REF-412'
    ]
  },
  {
    pageNumber: 4,
    tileNumber: 3,
    y: 445,
    height: 250,
    expectedReferences: ['REF-412', 'REF-413', 'REF-414', 'REF-415']
  }
] as const;

export interface RenderedTile extends RenderedPage {
  tileNumber: number;
  y: number;
  height: number;
  expectedReferences: readonly string[];
}

function assertSyntheticPdf(pdf: Buffer): void {
  const expectedHash = createHash('sha256').update(buildSyntheticStatementPdf()).digest('hex');
  if (createHash('sha256').update(pdf).digest('hex') !== expectedHash) {
    throw new Error('Only the built-in synthetic PDF is accepted');
  }
}

function assertPng(png: Buffer, label: string): void {
  if (
    png.length === 0 ||
    png.length > MAX_PNG_BYTES ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error(`Invalid or oversized rendered ${label}`);
}

/** Poppler is required locally; the SHA check prevents accidental real-PDF benchmarking. */
export async function renderSyntheticPages(pdf: Buffer): Promise<RenderedPage[]> {
  assertSyntheticPdf(pdf);
  const directory = await mkdtemp(join(tmpdir(), 'spends-pdf-benchmark-'));
  const input = join(directory, 'synthetic-statement.pdf');
  try {
    await writeFile(input, pdf);
    const { stdout } = await exec('pdfinfo', [input], { timeout: 10_000, maxBuffer: 64 * 1024 });
    const count = Number(/^Pages:\s+(\d+)$/m.exec(stdout)?.[1]);
    if (count !== SYNTHETIC_PAGES.length) throw new Error('Synthetic PDF page count mismatch');
    const rendered: RenderedPage[] = [];
    for (let pageNumber = 1; pageNumber <= count; pageNumber++) {
      const output = join(directory, `page-${pageNumber}`);
      await exec(
        'pdftoppm',
        [
          '-f',
          String(pageNumber),
          '-l',
          String(pageNumber),
          '-r',
          '110',
          '-png',
          '-singlefile',
          input,
          output
        ],
        { timeout: 20_000, maxBuffer: 64 * 1024 }
      );
      const png = await readFile(`${output}.png`);
      assertPng(png, `page ${pageNumber}`);
      rendered.push({ pageNumber, png });
    }
    return rendered;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Three fixed vertical regions; overlap rows 405 and 412 are audited downstream. */
export async function renderSyntheticDenseTiles(pdf: Buffer): Promise<RenderedTile[]> {
  assertSyntheticPdf(pdf);
  const directory = await mkdtemp(join(tmpdir(), 'spends-pdf-tiles-'));
  const input = join(directory, 'synthetic-statement.pdf');
  try {
    await writeFile(input, pdf);
    const rendered: RenderedTile[] = [];
    for (const spec of SYNTHETIC_TILE_SPECS) {
      const output = join(directory, `tile-${spec.tileNumber}`);
      await exec(
        'pdftoppm',
        [
          '-f',
          String(spec.pageNumber),
          '-l',
          String(spec.pageNumber),
          '-r',
          '110',
          '-png',
          '-singlefile',
          '-x',
          '0',
          '-y',
          String(spec.y),
          '-W',
          '935',
          '-H',
          String(spec.height),
          input,
          output
        ],
        { timeout: 20_000, maxBuffer: 64 * 1024 }
      );
      const png = await readFile(`${output}.png`);
      assertPng(png, `tile ${spec.tileNumber}`);
      rendered.push({ ...spec, png });
    }
    return rendered;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
