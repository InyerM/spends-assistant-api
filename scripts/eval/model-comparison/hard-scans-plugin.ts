import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { config } from 'dotenv';
import { HARD_CASES, parseHardJson, scoreHardRows } from './hard-scans-fixtures';
import { reserveBudget } from './comparison';
const exec = promisify(execFile);
const directory = '/tmp/spends-hard-synthetic-scans';
interface Model {
  id: string;
  pricing: { prompt: string; completion: string };
}
interface Prior {
  reservedWorstCaseUsd: number;
  fixtures: { id: string; pngSha256: string }[];
}
async function main() {
  const live = process.argv.includes('--live');
  if (process.argv.some((arg) => arg.startsWith('--') && arg !== '--live'))
    throw new Error('Built-in fixtures only');
  const prior = JSON.parse(
    await readFile('docs/evaluations/2026-11-11-hard-scans-live.json', 'utf8')
  ) as Prior;
  for (const fixture of HARD_CASES) {
    const png = await readFile(`${directory}/${fixture.id}.png`);
    if (
      createHash('sha256').update(png).digest('hex') !==
      prior.fixtures.find((f) => f.id === fixture.id)?.pngSha256
    )
      throw new Error('Synthetic image hash mismatch');
  }
  await exec('/opt/homebrew/bin/python3', [
    '-c',
    `from PIL import Image,JpegImagePlugin\nimport sys\nimages=[Image.open(sys.argv[1]+'/'+name+'.png').convert('RGB') for name in sys.argv[2:]]\nimages[0].save(sys.argv[1]+'/hard-scans.pdf',save_all=True,append_images=images[1:],resolution=110,quality=100)`,
    directory,
    ...HARD_CASES.map((f) => f.id)
  ]);
  const pdfPath = `${directory}/hard-scans.pdf`;
  const info = await exec('pdfinfo', [pdfPath]);
  if (!/^Pages:\s+3$/m.test(info.stdout)) throw new Error('Expected three pages');
  const text = await exec('pdftotext', [pdfPath, '-']);
  if (text.stdout.replace(/\s/g, '')) throw new Error('Raster PDF must have no text layer');
  await exec('pdftoppm', ['-r', '110', '-png', pdfPath, `${directory}/pdf-review`]);
  if (!live) {
    console.log('Raster PDF built: inspect pdf-review-{1,2,3}.png before --live');
    return;
  }
  config({ path: '.env.local', quiet: true });
  const key = process.env.OR_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('Key required');
  const response = await fetch('https://openrouter.ai/api/v1/models');
  if (!response.ok) throw new Error('Catalog unavailable');
  const catalog = (await response.json()) as { data: Model[] };
  const model = catalog.data.find((m) => m.id === 'deepseek/deepseek-v4.1-flash');
  if (!model) throw new Error('Exact route unavailable');
  const reservation =
    50000 * Number(model.pricing.prompt) + 4096 * Number(model.pricing.completion) + 0.05;
  if (!reserveBudget(prior.reservedWorstCaseUsd, reservation, 0.5))
    throw new Error('Aggregate cap exceeded');
  const pdf = await readFile(pdfPath);
  const start = performance.now();
  const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-Title': 'spends-hard-synthetic-pdf-only'
    },
    body: JSON.stringify({
      model: model.id,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Extract every movement only, exclude balances/totals. Return JSON {"rows":[{"reference":string,"amount":number,"currency":string,"date":"YYYY-MM-DD","direction":"debit"|"credit"}]}. Preserve the literal printed numeric sign: unsigned values remain positive even when the movement is debit; direction is a separate field from the printed sign. Respect each row currency and printed number locale. Do not invent or duplicate rows.'
            },
            {
              type: 'file',
              file: {
                filename: 'hard-synthetic-scans.pdf',
                file_data: `data:application/pdf;base64,${pdf.toString('base64')}`
              }
            }
          ]
        }
      ],
      plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }],
      temperature: 0,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
      usage: { include: true },
      provider: {
        data_collection: 'deny',
        max_price: {
          prompt: Number(model.pricing.prompt) * 1e6,
          completion: Number(model.pricing.completion) * 1e6
        }
      }
    }),
    signal: AbortSignal.timeout(60000)
  });
  const body = upstream.ok
    ? ((await upstream.json()) as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
        usage?: Record<string, unknown>;
      })
    : {};
  const parsed = parseHardJson(body.choices?.[0]?.message?.content || 'null');
  const score = scoreHardRows(
    HARD_CASES.flatMap((f) => [...f.rows]),
    parsed.data?.rows
  );
  const report = {
    generatedAt: new Date().toISOString(),
    pathway: 'mistral-ocr-pdf-plugin',
    model,
    syntheticRasterOnly: true,
    textLayerCharacters: 0,
    pages: 3,
    pdfSha256: createHash('sha256').update(pdf).digest('hex'),
    sourcePngHashes: prior.fixtures.map(({ id, pngSha256 }) => ({ id, pngSha256 })),
    reservedWorstCaseUsd: reservation,
    aggregateReservedWorstCaseUsd: prior.reservedWorstCaseUsd + reservation,
    budgetLimitUsd: 0.5,
    retries: 0,
    privacy: 'data_collection=deny; synthetic only; no ZDR claim',
    status: upstream.status,
    latencyMs: Math.round(performance.now() - start),
    usage: body.usage ?? null,
    strictSchema: parsed.strict && score.schemaValid,
    normalizedSchema: score.schemaValid,
    finishReason: body.choices?.[0]?.finish_reason ?? null,
    score,
    data: parsed.data,
    winner: null
  };
  await writeFile(
    'docs/evaluations/2026-11-11-hard-scans-plugin.json',
    JSON.stringify(report, null, 2) + '\n'
  );
  console.log(
    JSON.stringify({
      status: report.status,
      reservation,
      aggregate: report.aggregateReservedWorstCaseUsd,
      score,
      usage: report.usage
    })
  );
}
main().catch(() => {
  console.error('Raster PDF probe failed; no credentials or upstream bodies retained.');
  process.exitCode = 1;
});
