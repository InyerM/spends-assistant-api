import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  validateTriageBatch,
  buildTriagePrompt,
  summarizeTriage,
  restoreTriageCheckpoint,
  classifyBatch
} from '../../scripts/shortcut-ai-triage.mjs';

const notices = [
  {
    index: 0,
    received_at: '2026-08-01T12:00:00-05:00',
    raw_text: 'Nequi: No te alcanzo para pagar 25000'
  },
  {
    index: 1,
    received_at: '2026-08-02T12:00:00-05:00',
    raw_text: 'Bancolombia: Recibiste $100.000'
  }
];

test('requires one grounded result per notice and rejects invented evidence', () => {
  const valid = {
    items: [
      {
        index: 0,
        kind: 'failed_attempt',
        certainty: 'high',
        evidence: 'No te alcanzo',
        reason: 'Insufficient funds',
        possible_own_account: null
      },
      {
        index: 1,
        kind: 'incoming_transfer',
        certainty: 'high',
        evidence: 'Recibiste',
        reason: 'Funds received',
        possible_own_account: null
      }
    ]
  };
  assert.deepEqual(validateTriageBatch(notices, valid), valid.items);
  assert.throws(
    () =>
      validateTriageBatch(notices, {
        items: [valid.items[0], { ...valid.items[1], evidence: 'invented receipt' }]
      }),
    /Evidence not found/
  );
  assert.throws(
    () => validateTriageBatch(notices, { items: [valid.items[0]] }),
    /Missing or repeated/
  );
});

test('prompt carries only supplied notices and explicitly treats insufficient funds as unposted', () => {
  const prompt = buildTriagePrompt(notices);
  assert.match(prompt.system, /insufficient funds/i);
  assert.match(prompt.system, /do not infer/i);
  assert.match(prompt.user, /No te alcanzo/);
  assert.equal(prompt.user.includes('Bancolombia: Recibiste'), true);
});

test('summarizes model suggestions without treating them as approved transactions', () => {
  const result = summarizeTriage([
    { index: 0, kind: 'failed_attempt', certainty: 'high' },
    { index: 1, kind: 'incoming_transfer', certainty: 'low' }
  ]);
  assert.deepEqual(result, {
    total: 2,
    by_kind: { failed_attempt: 1, incoming_transfer: 1 },
    by_certainty: { high: 1, low: 1 }
  });
});

test('restores a validated completed batch without another model call', () => {
  const items = [
    {
      index: 0,
      kind: 'failed_attempt',
      certainty: 'high',
      evidence: 'No te alcanzo',
      reason: 'Falló.',
      possible_own_account: null
    },
    {
      index: 1,
      kind: 'incoming_transfer',
      certainty: 'high',
      evidence: 'Recibiste',
      reason: 'Entró dinero.',
      possible_own_account: null
    }
  ];
  const restored = restoreTriageCheckpoint(
    notices,
    {
      input_sha256: 'example-hash',
      model: 'deepseek/deepseek-v4.1-flash',
      offset: 0,
      items,
      usage: { prompt_tokens: 10, completion_tokens: 20, cost_usd: 0.001 }
    },
    'example-hash',
    0
  );
  assert.deepEqual(restored.items, items);
  assert.equal(restored.usage.cost_usd, 0.001);
});

test('retries a transient malformed provider response without exposing its body', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response('{', { status: 200 });
    return Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              items: [
                {
                  index: 0,
                  kind: 'failed_attempt',
                  certainty: 'high',
                  evidence: 'No te alcanzo',
                  reason: 'Falló.',
                  possible_own_account: null
                }
              ]
            })
          }
        }
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.001 }
    });
  };
  try {
    const result = await classifyBatch([notices[0]], 'synthetic-api-key');
    assert.equal(calls, 2);
    assert.equal(result.items[0].kind, 'failed_attempt');
  } finally {
    globalThis.fetch = original;
  }
});
