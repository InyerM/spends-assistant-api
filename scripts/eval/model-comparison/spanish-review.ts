import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { config } from 'dotenv';
import { reviewCategory, type CategoryReviewInput } from '../../../src/ai/category-review';
import type { Category } from '../../../src/types/category';
import { reserveBudget } from './comparison';

const IDS = ['deepseek/deepseek-v4.1-flash', 'mistralai/mistral-small-2603', 'amazon/nova-lite-v1'];
const categories: Category[] = [
  ['work', 'work', 'Trabajo'],
  ['education', 'education', 'Educación'],
  ['restaurant', 'restaurant', 'Restaurantes'],
  ['shopping', 'shopping', 'Compras'],
  ['health', 'health', 'Salud']
].map(([id, slug, name]) => ({
  id,
  slug,
  name,
  user_id: 'synthetic-owner',
  type: 'expense',
  is_active: true,
  parent_id: null,
  icon: null,
  color: null,
  created_at: '2026-11-11',
  translations: { es: name }
}));
interface Fixture {
  id: string;
  input: CategoryReviewInput;
  rule?: { category_id: string; name: string };
  expected: {
    category: string | null;
    kind: string;
    notes?: string;
    titleIncludes?: string;
    requiredEvidence?: string;
  };
}
const base: CategoryReviewInput = { locale: 'es', type: 'expense', description: '', history: [] };
const fixtures: Fixture[] = [
  {
    id: 'rule-over-history',
    input: {
      ...base,
      description: 'Café Aurora DEMO',
      notes: 'Reunión con cliente',
      history: [{ id: 'h-restaurant', description: 'Café Aurora DEMO', category: 'Restaurantes' }]
    },
    rule: { category_id: 'work', name: 'Reuniones con clientes' },
    expected: {
      category: 'work',
      kind: 'expense',
      notes: 'Reunión con cliente',
      titleIncludes: 'Aurora'
    }
  },
  {
    id: 'contact-linked-purpose',
    input: {
      ...base,
      description: 'Pago a Lina DEMO',
      notes: 'Mensualidad escolar',
      history: [
        {
          id: 'h-contact',
          description: 'Apoyo escolar',
          notes: 'Mensualidad del colegio',
          category: 'Educación'
        }
      ]
    },
    expected: {
      category: 'education',
      kind: 'expense',
      notes: 'Mensualidad escolar',
      titleIncludes: 'Lina',
      requiredEvidence: 'h-contact'
    }
  },
  {
    id: 'explicit-purpose-over-merchant',
    input: {
      ...base,
      description: 'Café Aurora DEMO',
      notes: 'Compra de libros para el curso',
      history: [
        {
          id: 'h-coffee',
          description: 'Café Aurora DEMO',
          notes: 'Desayuno',
          category: 'Restaurantes'
        }
      ]
    },
    expected: {
      category: 'education',
      kind: 'expense',
      notes: 'Compra de libros para el curso',
      titleIncludes: 'Aurora'
    }
  },
  {
    id: 'ambiguous-transfer',
    input: {
      ...base,
      description: 'Transferencia a Alex DEMO',
      excerpt: 'Transferencia realizada a Alex DEMO. No se identifica titularidad ni finalidad.'
    },
    expected: { category: null, kind: 'unknown', titleIncludes: 'Alex' }
  },
  {
    id: 'marketplace-without-item',
    input: { ...base, description: 'Compra en Mercado Libre', history: [] },
    expected: { category: 'shopping', kind: 'expense', notes: '', titleIncludes: 'Mercado Libre' }
  },
  {
    id: 'description-notes-separation',
    input: {
      ...base,
      description: 'Pago en Clínica Lirio DEMO',
      notes: 'Control anual de salud',
      excerpt: 'Consulta médica en Clínica Lirio DEMO.'
    },
    expected: {
      category: 'health',
      kind: 'expense',
      notes: 'Control anual de salud',
      titleIncludes: 'Lirio'
    }
  }
];
interface Attempt {
  model: string;
  caseId: string;
  reservationUsd: number;
  status: number | null;
  costUsd: number | null;
  strictJson: boolean;
  raw: unknown;
  error: string | null;
}
async function main() {
  if (process.argv.slice(2).join(' ') !== '--live')
    throw new Error('Explicit --live required; built-in synthetic fixtures only');
  config({ path: '.env.local', quiet: true });
  const key = process.env.OR_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('Local OpenRouter key required');
  const realFetch = globalThis.fetch;
  const response = await realFetch('https://openrouter.ai/api/v1/models');
  if (!response.ok) throw new Error('Catalog unavailable');
  const catalog = (
    (await response.json()) as {
      data: Array<{ id: string; pricing: { prompt: string; completion: string } }>;
    }
  ).data;
  const selected = IDS.map((id) => {
    const model = catalog.find((m) => m.id === id);
    if (!model) throw new Error('Required catalog model unavailable');
    return model;
  });
  const attempts: Attempt[] = [];
  let reserved = 0;
  let activeCase = '';
  globalThis.fetch = async (input, init) => {
    if (String(input) !== 'https://openrouter.ai/api/v1/chat/completions')
      throw new Error('Only OpenRouter inference endpoint allowed');
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      max_tokens: number;
      messages: unknown;
      tools?: unknown;
      provider: {
        zdr: boolean;
        data_collection: string;
        max_price: { prompt: number; completion: number };
      };
    };
    if (body.tools || body.provider.zdr !== true || body.provider.data_collection !== 'deny')
      throw new Error('Unexpected provider privacy or tool configuration');
    const promptByteBound = Buffer.byteLength(JSON.stringify(body.messages), 'utf8') + 1024;
    const reservation =
      (promptByteBound * body.provider.max_price.prompt +
        body.max_tokens * body.provider.max_price.completion) /
      1e6;
    if (!reserveBudget(reserved, reservation, 0.25))
      throw new Error('Additional quarter-dollar reservation exhausted');
    reserved += reservation;
    const attempt: Attempt = {
      model: body.model,
      caseId: activeCase,
      reservationUsd: reservation,
      status: null,
      costUsd: null,
      strictJson: false,
      raw: null,
      error: null
    };
    attempts.push(attempt);
    try {
      const reply = await realFetch(input, init);
      attempt.status = reply.status;
      if (reply.ok) {
        const envelope = (await reply.clone().json()) as {
          usage?: { cost?: number };
          choices?: Array<{ message?: { content?: string } }>;
        };
        attempt.costUsd = typeof envelope.usage?.cost === 'number' ? envelope.usage.cost : null;
        try {
          attempt.raw = JSON.parse(envelope.choices?.[0]?.message?.content || 'null') as unknown;
          attempt.strictJson = attempt.raw !== null;
        } catch {
          attempt.error = 'non_strict_json';
        }
      } else attempt.error = 'http';
      return reply;
    } catch (error) {
      attempt.error = 'network_or_envelope';
      throw error;
    }
  };
  const results: Record<string, unknown>[] = [];
  try {
    for (const model of selected)
      for (const fixture of fixtures) {
        activeCase = fixture.id;
        const started = performance.now();
        try {
          const value = await reviewCategory(fixture.input, categories, key, model.id, undefined, {
            preferences: [],
            ...(fixture.rule ? { categoryRule: fixture.rule } : {})
          });
          const checks = {
            category: value.category_id === fixture.expected.category,
            kind: value.kind === fixture.expected.kind,
            notes: fixture.expected.notes === undefined || value.notes === fixture.expected.notes,
            title:
              !fixture.expected.titleIncludes ||
              value.description
                .toLowerCase()
                .includes(fixture.expected.titleIncludes.toLowerCase()),
            evidence:
              !fixture.expected.requiredEvidence ||
              value.evidence_ids.includes(fixture.expected.requiredEvidence)
          };
          results.push({
            model: model.id,
            caseId: fixture.id,
            latencyMs: Math.round(performance.now() - started),
            value,
            checks,
            pass: Object.values(checks).every(Boolean)
          });
        } catch {
          results.push({
            model: model.id,
            caseId: fixture.id,
            latencyMs: Math.round(performance.now() - started),
            pass: false,
            error: 'production_review_failed'
          });
        }
      }
  } finally {
    globalThis.fetch = realFetch;
  }
  const hashes = await Promise.all(
    ['src/ai/category-review.ts', 'src/ai/openrouter.ts'].map(async (path) => ({
      path,
      sha256: createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
    }))
  );
  const artifact = {
    generatedAt: new Date().toISOString(),
    scope:
      'Synthetic Spanish inputs through real reviewCategory; no retrieval or posting; no model winner',
    provider:
      'Production exact: zdr=true,data_collection=deny,max_price prompt0.4/completion1; no tools',
    limitUsd: 0.25,
    reservedUsd: reserved,
    knownCostUsd: attempts.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0),
    costComplete: attempts.every((attempt) => attempt.costUsd !== null),
    catalog: selected,
    nova2Availability: {
      model: 'amazon/nova-2-lite-v1',
      pricing: catalog.find((model) => model.id === 'amazon/nova-2-lite-v1')?.pricing ?? null,
      attempted: false,
      reason:
        'Catalog output price exceeds production completion max_price=1 USD per million tokens'
    },
    sourceHashes: hashes,
    fixtures,
    results,
    attempts
  };
  await writeFile(
    'docs/evaluations/2026-11-11-spanish-review.json',
    JSON.stringify(artifact, null, 2) + '\n'
  );
  console.log(
    JSON.stringify({
      cases: results.length,
      attempts: attempts.length,
      reservedUsd: reserved,
      knownCostUsd: artifact.knownCostUsd,
      costComplete: artifact.costComplete
    })
  );
}
main().catch(() => {
  console.error('Spanish synthetic evaluation failed; no credentials or upstream errors retained.');
  process.exitCode = 1;
});
