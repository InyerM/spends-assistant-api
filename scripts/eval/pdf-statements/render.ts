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

/** Poppler is required locally; the SHA check prevents accidental real-PDF benchmarking. */
export async function renderSyntheticPages(pdf: Buffer): Promise<RenderedPage[]> {
  const expectedHash = createHash('sha256').update(buildSyntheticStatementPdf()).digest('hex');
  if (createHash('sha256').update(pdf).digest('hex') !== expectedHash) {
    throw new Error('Only the built-in synthetic PDF is accepted');
  }
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
      if (
        png.length === 0 ||
        png.length > MAX_PNG_BYTES ||
        !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ) {
        throw new Error(`Invalid or oversized rendered page ${pageNumber}`);
      }
      rendered.push({ pageNumber, png });
    }
    return rendered;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
