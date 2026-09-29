import { describe, expect, it } from 'vitest';
import {
  FIXTURES,
  checkFixturePrivacy,
  checkFixtureShape
} from '../../../scripts/eval/text-models/fixtures';
import { MODELS, estimateCostUsd, selectModels } from '../../../scripts/eval/text-models/models';
import {
  fieldMatches,
  isSchemaValid,
  percentile,
  pickVerdict,
  scoreFixture,
  summarizeModel
} from '../../../scripts/eval/text-models/scoring';
import type {
  CallResult,
  Fixture,
  FixtureScore,
  ModelSummary
} from '../../../scripts/eval/text-models/types';

const model = MODELS[0];

function ok(data: Record<string, unknown>, extra: Partial<CallResult> = {}): CallResult {
  return {
    latencyMs: 100,
    usage: { promptTokens: 1000, completionTokens: 100, costUsd: 0.0002 },
    data,
    error: null,
    ...extra
  };
}

const txFixture: Fixture = {
  id: 'tx',
  category: 'bank_sms',
  text: 'synthetic',
  expected: {
    is_transaction: true,
    fields: { amount: 1000, category: 'groceries', source: ['a', 'b'], last_four: null }
  }
};
const nonTxFixture: Fixture = {
  id: 'non-tx',
  category: 'non_transaction',
  text: 'synthetic',
  expected: { is_transaction: false }
};
const validTx = {
  is_transaction: true,
  amount: 1000,
  description: 'x',
  category: 'Groceries',
  source: 'b',
  last_four: null
};

describe('fixtures', () => {
  it('pass the shape and privacy checks', () => {
    expect(checkFixtureShape(FIXTURES)).toEqual([]);
    expect(checkFixturePrivacy(FIXTURES)).toEqual([]);
  });

  it('cover every category the issue requires', () => {
    const categories = new Set(FIXTURES.map((f) => f.category));
    for (const c of ['bank_sms', 'transfer', 'nequi', 'non_transaction', 'ambiguous_date']) {
      expect(categories).toContain(c);
    }
  });

  it('flag PII-shaped text', () => {
    const leaky = (text: string): Fixture => ({ ...nonTxFixture, id: text, text });
    expect(
      checkFixturePrivacy([
        leaky('write to someone@example.com'),
        leaky('card 4111 1111 1111'),
        leaky('call 3001234567'),
        leaky('see https://bank.example/x?id=1')
      ])
    ).toHaveLength(5);
  });

  it('flag duplicate ids, empty text, and mismatched expectations', () => {
    const problems = checkFixtureShape([
      { ...txFixture, expected: { is_transaction: true } },
      { ...txFixture, text: ' ' },
      { ...nonTxFixture, expected: { is_transaction: false, fields: { amount: 1 } } }
    ]);
    expect(problems).toEqual([
      'tx: transaction fixture scores no fields',
      'tx: duplicate id',
      'tx: empty text',
      'non-tx: non-transaction fixture should not score fields'
    ]);
  });
});

describe('models', () => {
  it('select required models by default and optional ones on request', () => {
    expect(selectModels({ includeOptional: false }).map((m) => m.id)).toEqual([
      'deepseek/deepseek-v4.1-flash',
      'qwen/qwen3-vl-30b-a3b-instruct'
    ]);
    expect(selectModels({ includeOptional: true })).toHaveLength(MODELS.length);
    expect(selectModels({ ids: ['openai/gpt-5-mini'], includeOptional: false })).toHaveLength(1);
    expect(() => selectModels({ ids: ['nope/model'], includeOptional: false })).toThrow(
      'Unknown model id(s): nope/model'
    );
  });

  it('estimate cost from per-million prices', () => {
    expect(estimateCostUsd(model, 1_000_000, 1_000_000)).toBeCloseTo(0.65);
  });
});

describe('scoring', () => {
  it('validate schema like parseExpense does', () => {
    expect(isSchemaValid({ is_transaction: false })).toBe(true);
    expect(isSchemaValid(validTx)).toBe(true);
    expect(isSchemaValid({ ...validTx, amount: '1000' })).toBe(false);
    expect(isSchemaValid({ ...validTx, amount: 0 })).toBe(false);
    expect(isSchemaValid({ ...validTx, description: ' ' })).toBe(false);
    expect(isSchemaValid({ ...validTx, category: '' })).toBe(false);
    expect(isSchemaValid({ amount: 1 })).toBe(false);
  });

  it('match fields case-insensitively, with alternatives and null equivalence', () => {
    expect(fieldMatches('category', ' Groceries ', 'groceries')).toBe(true);
    expect(fieldMatches('source', 'b', ['a', 'b'])).toBe(true);
    expect(fieldMatches('last_four', '', null)).toBe(true);
    expect(fieldMatches('last_four', undefined, null)).toBe(true);
    expect(fieldMatches('amount', 1000.4, 1000)).toBe(true);
    expect(fieldMatches('amount', '1000', 1000)).toBe(false);
    expect(fieldMatches('amount', 1002, 1000)).toBe(false);
  });

  it('score a correct transaction', () => {
    const score = scoreFixture(txFixture, ok(validTx));
    expect(score).toMatchObject({ jsonValid: true, schemaValid: true, fieldsCorrect: 4 });
    expect(score.mismatchedFields).toEqual([]);
  });

  it('record wrong fields by name only', () => {
    const score = scoreFixture(txFixture, ok({ ...validTx, amount: 999, category: 'rent' }));
    expect(score.fieldsCorrect).toBe(2);
    expect(score.mismatchedFields).toEqual(['amount', 'category']);
  });

  it('count every field wrong when a transaction is missed', () => {
    const score = scoreFixture(txFixture, ok({ is_transaction: false }));
    expect(score.predictedTransaction).toBe(false);
    expect(score.mismatchedFields).toEqual([
      'is_transaction',
      'amount',
      'category',
      'source',
      'last_four'
    ]);
  });

  it('flag false transactions and schema failures', () => {
    const score = scoreFixture(nonTxFixture, ok({ is_transaction: true, amount: 5 }));
    expect(score).toMatchObject({ schemaValid: false, predictedTransaction: true });
    expect(score.mismatchedFields).toEqual(['schema', 'is_transaction']);
  });

  it('treat a missing is_transaction as unknown', () => {
    expect(scoreFixture(nonTxFixture, ok({})).predictedTransaction).toBeNull();
  });

  it('record failed calls as invalid JSON', () => {
    const score = scoreFixture(txFixture, {
      latencyMs: 5,
      usage: null,
      data: null,
      error: 'http',
      status: 500
    });
    expect(score).toMatchObject({ jsonValid: false, fieldsCorrect: 0 });
    expect(score.mismatchedFields).toEqual(['call:http']);
    expect(
      scoreFixture(txFixture, { latencyMs: 0, usage: null, data: null, error: null })
        .mismatchedFields
    ).toEqual(['call:unknown']);
  });

  it('compute nearest-rank percentiles', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([30, 10, 20, 40], 50)).toBe(20);
    expect(percentile([30, 10, 20, 40], 95)).toBe(40);
    expect(percentile([7], 0)).toBe(7);
  });
});

describe('summarizeModel', () => {
  const scores: FixtureScore[] = [
    scoreFixture(txFixture, ok(validTx, { latencyMs: 200 })),
    scoreFixture(txFixture, ok({ is_transaction: false }, { latencyMs: 400 })),
    scoreFixture(nonTxFixture, ok({ is_transaction: true }, { latencyMs: 100 })),
    scoreFixture(nonTxFixture, ok({ is_transaction: false }, { latencyMs: 300, usage: null }))
  ];

  it('aggregate accuracy, error rates, latency, and observed cost', () => {
    const s = summarizeModel(model, scores);
    expect(s.runs).toBe(4);
    expect(s.jsonValidRate).toBe(1);
    expect(s.schemaValidRate).toBe(0.75);
    expect(s.detectionAccuracy).toBe(0.5);
    expect(s.falseTransactionRate).toBe(0.5);
    expect(s.missedTransactionRate).toBe(0.5);
    expect(s.fieldAccuracy).toBe(0.5);
    expect(s.fieldAccuracyByCategory).toEqual({ bank_sms: 0.5, non_transaction: 0.5 });
    expect(s.latencyP50Ms).toBe(200);
    expect(s.latencyP95Ms).toBe(400);
    expect(s.observedCostUsd).toBeCloseTo(0.0006);
    expect(s.costCoverage).toBe(0.75);
    expect(s.costPer1kUsd).toBeCloseTo(0.2);
    expect(s.failures.map((f) => f.fixtureId)).toEqual(['tx', 'non-tx']);
  });

  it('fall back to estimated cost when OpenRouter reports none', () => {
    const unreported = [
      scoreFixture(
        txFixture,
        ok(validTx, { usage: { promptTokens: 1000, completionTokens: 100, costUsd: null } })
      )
    ];
    const s = summarizeModel(model, unreported);
    expect(s.observedCostUsd).toBeNull();
    expect(s.estimatedCostUsd).toBeCloseTo(0.000182);
    expect(s.costPer1kUsd).toBeCloseTo(0.182);
  });

  it('handle an empty run', () => {
    const s = summarizeModel(model, []);
    expect(s).toMatchObject({
      runs: 0,
      fieldAccuracy: null,
      falseTransactionRate: null,
      costPer1kUsd: 0
    });
  });
});

describe('pickVerdict', () => {
  const base = summarizeModel(model, [scoreFixture(txFixture, ok(validTx))]);
  const summary = (overrides: Partial<ModelSummary>): ModelSummary => ({
    ...base,
    runs: 100,
    ...overrides
  });

  it('report no winner without models', () => {
    expect(pickVerdict([])).toMatchObject({ winner: null, uncertain: true });
  });

  it('mark a single model as uncertain', () => {
    expect(pickVerdict([summary({ modelId: 'a' })])).toMatchObject({
      winner: 'a',
      uncertain: true
    });
  });

  it('declare a clear winner when the gap beats the noise margin', () => {
    const verdict = pickVerdict([
      summary({ modelId: 'weak', fieldAccuracy: 0.6 }),
      summary({ modelId: 'strong', fieldAccuracy: 1 })
    ]);
    expect(verdict).toMatchObject({ winner: 'strong', uncertain: false });
  });

  it('prefer the cheaper model when quality is within noise', () => {
    const verdict = pickVerdict([
      summary({ modelId: 'pricey', costPer1kUsd: 2 }),
      summary({ modelId: 'cheap', fieldAccuracy: 0.98, costPer1kUsd: 0.2 })
    ]);
    expect(verdict).toMatchObject({ winner: 'cheap', uncertain: true });
    const reversed = pickVerdict([
      summary({ modelId: 'cheap-best', costPer1kUsd: 0.1 }),
      summary({ modelId: 'pricey', fieldAccuracy: 0.98, costPer1kUsd: 2 })
    ]);
    expect(reversed.winner).toBe('cheap-best');
  });

  it('refuse a confident winner with poor JSON validity', () => {
    const verdict = pickVerdict([
      summary({ modelId: 'a', jsonValidRate: 0.9 }),
      summary({ modelId: 'b', fieldAccuracy: 0.1 })
    ]);
    expect(verdict).toMatchObject({ winner: 'a', uncertain: true });
    expect(verdict.reason).toContain('90.0%');
  });
});
