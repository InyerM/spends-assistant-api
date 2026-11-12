import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { config } from 'dotenv';
import { HARD_CASES, parseHardJson, scoreHardRows } from './hard-scans-fixtures';
import { reserveBudget } from './comparison';
const exec = promisify(execFile);
const directory = '/tmp/spends-hard-synthetic-scans';
const ids = [
  'qwen/qwen3-vl-30b-a3b-instruct',
  'mistralai/mistral-small-2603',
  'amazon/nova-2-lite-v1'
];
interface Model {
  id: string;
  pricing: { prompt: string; completion: string };
  architecture: { input_modalities: string[] };
}
interface Reply {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number };
}
async function main() {
  const live = process.argv.includes('--live');
  if (process.argv.some((arg) => arg.startsWith('--') && arg !== '--live'))
    throw new Error('Only built-in synthetic fixtures supported');
  config({ path: '.env.local', quiet: true });
  const key = process.env.OR_API_KEY || process.env.OPENROUTER_API_KEY;
  if (live && !key) throw new Error('Key required');
  await mkdir(directory, { recursive: true });
  await exec('/opt/homebrew/bin/python3', [
    '-c',
    `import json,sys\nfrom PIL import Image,ImageDraw,ImageFont,ImageFilter,ImageEnhance\nfixtures=json.loads(sys.argv[1])\nfont=ImageFont.truetype('/System/Library/Fonts/Menlo.ttc',22)\nfor f in fixtures:\n image=Image.new('RGB',(1150,780),'white'); draw=ImageDraw.Draw(image)\n for i,line in enumerate(f['lines']): draw.text((32,35+i*39),line,font=font,fill='black')\n image=image.rotate(f['angle'],resample=Image.Resampling.BICUBIC,expand=False,fillcolor='white')\n image=ImageEnhance.Contrast(image).enhance(f['contrast']).filter(ImageFilter.GaussianBlur(f['blur']))\n image.save(sys.argv[2]+'/'+f['id']+'.png')`,
    JSON.stringify(HARD_CASES),
    directory
  ]);
  const catalogResponse = await fetch('https://openrouter.ai/api/v1/models');
  if (!catalogResponse.ok) throw new Error('Catalog unavailable');
  const catalog = ((await catalogResponse.json()) as { data: Model[] }).data;
  const models = ids.map((id) => {
    const m = catalog.find((m) => m.id === id);
    if (!m || !m.architecture.input_modalities.includes('image'))
      throw new Error('Image route unavailable');
    return { id: m.id, pricing: m.pricing };
  });
  const reservations = models.map(
    (m) => 50000 * Number(m.pricing.prompt) + 4096 * Number(m.pricing.completion)
  );
  const totalReservation = reservations.reduce((a, b) => a + b, 0) * HARD_CASES.length;
  if (!reserveBudget(0, totalReservation, 0.5))
    throw new Error('Global fifty cent predispatch cap exceeded');
  const records: Record<string, unknown>[] = [];
  const prompt =
    'Extract every movement only, exclude balances/totals. Return JSON {"rows":[{"reference":string,"amount":number,"currency":string,"date":"YYYY-MM-DD","direction":"debit"|"credit"}]}. Preserve the literal printed numeric sign: unsigned values remain positive even when the movement is debit; direction is a separate field from the printed sign. Respect each row currency and printed number locale. Do not invent or duplicate rows.';
  if (live)
    for (const model of models)
      for (const fixture of HARD_CASES) {
        const png = await readFile(`${directory}/${fixture.id}.png`);
        const start = performance.now();
        let reply: Reply = {};
        let status: number | null = null;
        let error: string | null = null;
        try {
          const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${key}`,
              'Content-Type': 'application/json',
              'X-Title': 'spends-hard-synthetic-only'
            },
            body: JSON.stringify({
              model: model.id,
              messages: [
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: prompt },
                    {
                      type: 'image_url',
                      image_url: { url: `data:image/png;base64,${png.toString('base64')}` }
                    }
                  ]
                }
              ],
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
          status = response.status;
          if (response.ok) reply = (await response.json()) as Reply;
          else error = `http_${status}`;
        } catch {
          error = 'network_timeout_or_invalid_json';
        }
        const parsed = parseHardJson(reply.choices?.[0]?.message?.content || 'null');
        const score = scoreHardRows(fixture.rows, parsed.data?.rows);
        records.push({
          model: model.id,
          fixture: fixture.id,
          status,
          error,
          latencyMs: Math.round(performance.now() - start),
          costUsd: reply.usage?.cost ?? null,
          inputTokens: reply.usage?.prompt_tokens ?? null,
          outputTokens: reply.usage?.completion_tokens ?? null,
          finishReason: reply.choices?.[0]?.finish_reason ?? null,
          strictSchema: parsed.strict && score.schemaValid,
          normalizedSchema: score.schemaValid,
          score,
          data: parsed.data
        });
      }
  const fixtures = await Promise.all(
    HARD_CASES.map(async (f) => ({
      ...f,
      pngSha256: createHash('sha256')
        .update(await readFile(`${directory}/${f.id}.png`))
        .digest('hex')
    }))
  );
  await mkdir('docs/evaluations', { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    mode: live ? 'live' : 'dry-run',
    catalog: models,
    reservedWorstCaseUsd: live ? totalReservation : 0,
    plannedReservationUsd: totalReservation,
    budgetLimitUsd: 0.5,
    retries: 0,
    plugins: [],
    privacy: 'Built-in synthetic only; data_collection=deny; no ZDR claim',
    fixtureReview:
      'Inspect local PNGs before --live; printed sign differs deliberately from direction.',
    fixtures,
    records,
    knownCostUsd: records.reduce((s, r) => s + (typeof r.costUsd === 'number' ? r.costUsd : 0), 0),
    costComplete: records.every((r) => typeof r.costUsd === 'number'),
    winner: null
  };
  await writeFile(
    `docs/evaluations/2026-11-11-hard-scans-${live ? 'live' : 'dry-run'}.json`,
    JSON.stringify(report, null, 2) + '\n'
  );
  console.log(
    JSON.stringify({
      mode: report.mode,
      reservation: totalReservation,
      cost: report.knownCostUsd,
      calls: records.length,
      fixtures: fixtures.map((f) => `${directory}/${f.id}.png`)
    })
  );
}
main().catch(() => {
  console.error('Hard synthetic evaluation failed; no credentials or upstream bodies retained.');
  process.exitCode = 1;
});
