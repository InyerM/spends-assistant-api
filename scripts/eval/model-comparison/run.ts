import { mkdir, writeFile } from 'node:fs/promises';
import { config } from 'dotenv';
import { buildSyntheticStatementPdf, SYNTHETIC_PAGES } from '../pdf-statements/fixture';
import { renderSyntheticPages } from '../pdf-statements/render';
import { reserveBudget, scoreRows, withFallback, parseModelJson, type Row } from './comparison';

const IDS = [
  'mistralai/mistral-small-2603',
  'amazon/nova-2-lite-v1',
  'qwen/qwen3-vl-30b-a3b-instruct',
  'deepseek/deepseek-v4.1-flash'
];
const signed: Row[] = [
  { reference: 'SIGN-1', amount: -12345.67, currency: 'COP', date: '2026-11-01' },
  { reference: 'SIGN-2', amount: 12345.67, currency: 'COP', date: '2026-11-02' },
  { reference: 'SIGN-3', amount: -12.5, currency: 'USD', date: '2026-10-31' }
];
const intelligence = [
  {
    id: 'rule-over-history',
    text: 'Merchant DEMO CAFE. Explicit user rule: category=work. History: category=restaurant.',
    expected: { category: 'work', contact: null, review: false }
  },
  {
    id: 'history',
    text: 'Merchant DEMO BOOKS. No rule. Last 4 confirmed purchases: category=education.',
    expected: { category: 'education', contact: null, review: false }
  },
  {
    id: 'ambiguous-contact',
    text: 'Transfer to Alex. Contacts: c1 Alex Demo; c2 Alex Sample. No account evidence.',
    expected: { category: null, contact: null, review: true }
  },
  {
    id: 'known-contact',
    text: 'Transfer to c3 DEMO LINA. User rule c3=family.',
    expected: { category: 'family', contact: 'c3', review: false }
  },
  {
    id: 'missing-evidence',
    text: 'Transfer reference X9, no merchant or contact or history.',
    expected: { category: null, contact: null, review: true }
  },
  {
    id: 'description-notes',
    text: 'Purchase DEMO CLINIC. Receipt: consultation. User note: annual checkup. No category evidence.',
    expected: {
      category: null,
      contact: null,
      review: true,
      description: 'consultation',
      notes: 'annual checkup'
    }
  }
];
interface CatalogModel {
  id: string;
  pricing: { prompt: string; completion: string };
  architecture: { input_modalities: string[] };
}
interface Reply {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}
async function main() {
  const live = process.argv.includes('--live');
  if (process.argv.some((arg) => arg.startsWith('--') && arg !== '--live'))
    throw new Error('Only --live supported; fixtures are built in');
  config({ path: '.env.local', quiet: true });
  const key = process.env.OR_API_KEY || process.env.OPENROUTER_API_KEY;
  if (live && !key) throw new Error('Local OpenRouter key required');
  const catalogResponse = await fetch('https://openrouter.ai/api/v1/models');
  if (!catalogResponse.ok) throw new Error('Catalog unavailable');
  const catalog = ((await catalogResponse.json()) as { data: CatalogModel[] }).data;
  const selected = IDS.map((id) => {
    const model = catalog.find((m) => m.id === id);
    if (!model) throw new Error(`Catalog route unavailable: ${id}`);
    return model;
  });
  const pdf = buildSyntheticStatementPdf();
  const pages = await renderSyntheticPages(pdf);
  const records: Record<string, unknown>[] = [];
  let reserved = 0;
  async function call(
    model: CatalogModel,
    task: string,
    prompt: string,
    attachment?: Record<string, unknown>,
    plugin = false
  ): Promise<Record<string, unknown> | null> {
    // Reserve 50k input + 4096 output tokens plus a conservative five-page OCR allowance.
    const reservation =
      50000 * Number(model.pricing.prompt) +
      4096 * Number(model.pricing.completion) +
      (plugin ? 0.05 : 0);
    if (!reserveBudget(reserved, reservation, 2))
      throw new Error('Two dollar reservation limit reached');
    reserved += reservation;
    const start = performance.now();
    let data: Record<string, unknown> | null = null;
    let usage: Reply['usage'];
    let error: string | null = null;
    let status: number | null = null;
    let strictJson = false;
    if (live) {
      try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            'X-Title': 'spends-synthetic-comparison'
          },
          body: JSON.stringify({
            model: model.id,
            messages: [
              {
                role: 'user',
                content: attachment ? [{ type: 'text', text: prompt }, attachment] : prompt
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
            },
            ...(plugin ? { plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }] } : {})
          }),
          signal: AbortSignal.timeout(60000)
        });
        status = response.status;
        if (!response.ok) error = `http_${status}`;
        else {
          const body = (await response.json()) as Reply;
          usage = body.usage;
          if (body.choices?.[0]?.finish_reason === 'length') error = 'truncated';
          else {
            const parsed = parseModelJson(body.choices?.[0]?.message?.content || 'null');
            data = parsed.data;
            strictJson = parsed.strict;
            if (!data) error = 'invalid_json';
          }
        }
      } catch {
        error = 'network_timeout_or_invalid_json';
      }
    }
    records.push({
      model: model.id,
      task,
      pathway: plugin ? 'mistral-ocr-pdf-plugin' : attachment ? 'chat-image' : 'chat-text',
      latencyMs: Math.round(performance.now() - start),
      costUsd: usage?.cost ?? null,
      inputTokens: usage?.prompt_tokens ?? null,
      outputTokens: usage?.completion_tokens ?? null,
      jsonValid: data !== null,
      strictJson,
      error,
      status,
      data
    });
    return data;
  }
  const extractPrompt =
    'Extract every movement, no balances or invented rows. Return JSON {"rows":[{"reference":string,"amount":number,"currency":string,"date":"YYYY-MM-DD"}]}. Preserve the printed numeric sign; unsigned numbers stay positive. Include every row and no duplicate references.';
  if (live) {
    for (const model of selected.slice(0, 3)) {
      for (const page of pages) {
        const result = await call(model, `image-page-${page.pageNumber}`, extractPrompt, {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${page.png.toString('base64')}` }
        });
        records[records.length - 1].score = scoreRows(
          SYNTHETIC_PAGES[page.pageNumber - 1].rows.map((row) => ({ ...row, date: row.date })),
          result?.rows
        );
      }
    }
    for (const model of selected) {
      const result = await call(
        model,
        'signed-currency-text',
        `${extractPrompt}\nSynthetic source rows:\n${JSON.stringify(signed)}`
      );
      records[records.length - 1].score = scoreRows(signed, result?.rows);
      const answer = await call(
        model,
        'intelligence',
        'Use explicit rules before confirmed history. Never guess ambiguous contact IDs. Missing evidence requires review=true and null category/contact. Keep receipt description separate from user notes. Return JSON {"answers":[{"id":string,"category":string|null,"contact":string|null,"review":boolean,"description"?:string,"notes"?:string}]}. Synthetic cases:\n' +
          JSON.stringify(intelligence.map(({ id, text }) => ({ id, text })))
      );
      const answers = Array.isArray(answer?.answers)
        ? (answer.answers as Record<string, unknown>[])
        : [];
      records[records.length - 1].score = intelligence.map((fixture) => ({
        id: fixture.id,
        pass: Object.entries(fixture.expected).every(
          ([field, value]) => answers.find((a) => a.id === fixture.id)?.[field] === value
        )
      }));
    }
    const plugin = await call(
      selected[3],
      'pdf-five-pages',
      extractPrompt,
      {
        type: 'file',
        file: {
          filename: 'synthetic.pdf',
          file_data: `data:application/pdf;base64,${pdf.toString('base64')}`
        }
      },
      true
    );
    records[records.length - 1].score = scoreRows(
      SYNTHETIC_PAGES.flatMap((page) => page.rows),
      plugin?.rows
    );
    // Real secondary call, injected invalid primary: tests failover, not a naturally observed outage.
    const fallback = await withFallback(
      async () => null,
      () =>
        call(selected[1], 'forced-mistral-to-nova', `${extractPrompt}\n${JSON.stringify(signed)}`),
      (data) => scoreRows(signed, (data as { rows?: unknown } | null)?.rows).pass
    );
    records[records.length - 1].fallback = {
      injectedPrimaryFailure: true,
      used: fallback.fallback,
      accepted: fallback.accepted
    };
    records[records.length - 1].score = scoreRows(
      signed,
      (fallback.data as { rows?: unknown } | null)?.rows
    );
  }
  const report = {
    generatedAt: new Date().toISOString(),
    mode: live ? 'live' : 'dry-run',
    privacy: 'built-in synthetic only; provider data_collection=deny; no ZDR claim',
    catalog: selected,
    reservedWorstCaseUsd: reserved,
    knownCostUsd: records.reduce(
      (sum, r) => sum + (typeof r.costUsd === 'number' ? r.costUsd : 0),
      0
    ),
    costComplete: records.every((r) => typeof r.costUsd === 'number'),
    verdict: {
      winner: null,
      reason: 'One repetition and synthetic-only fixtures cannot establish production superiority.'
    },
    records
  };
  await mkdir('docs/evaluations', { recursive: true });
  await writeFile(
    `docs/evaluations/2026-11-11-model-comparison-${live ? 'repeat' : 'dry-run'}.json`,
    JSON.stringify(report, null, 2) + '\n'
  );
  console.log(
    JSON.stringify({
      mode: report.mode,
      calls: records.length,
      reservedWorstCaseUsd: reserved,
      knownCostUsd: report.knownCostUsd
    })
  );
}
main().catch(() => {
  console.error('Comparison failed; no credentials or upstream bodies retained.');
  process.exitCode = 1;
});
