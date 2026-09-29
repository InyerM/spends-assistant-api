import { describe, expect, it, vi } from 'vitest';
import { SYNTHETIC_CASES } from '../../../scripts/eval/document-vectors/fixtures';
import {
  baselineCandidates,
  rankSemanticCandidates,
  runEvaluation
} from '../../../scripts/eval/document-vectors/benchmark';
import {
  buildEmbeddingRequest,
  createOpenRouterEmbedder
} from '../../../scripts/eval/document-vectors/client';

describe('synthetic document vector benchmark', () => {
  it('uses exact amount and a three-day date window before any semantic ranking', () => {
    const fixture = SYNTHETIC_CASES[0];
    const candidates = baselineCandidates(fixture.observation, [
      ...fixture.transactions,
      { ...fixture.transactions[0], id: 'wrong-amount', amount: 1 },
      { ...fixture.transactions[0], id: 'wrong-date', date: '2026-08-01' }
    ]);
    expect(candidates.map((candidate) => candidate.id)).not.toContain('wrong-amount');
    expect(candidates.map((candidate) => candidate.id)).not.toContain('wrong-date');
    expect(candidates.length).toBeGreaterThan(0);
  });

  it('reranks only eligible candidates and cannot override a closer date', () => {
    const fixture = SYNTHETIC_CASES[0];
    const candidates = baselineCandidates(fixture.observation, fixture.transactions);
    const vectors = new Map([
      [fixture.observation.id, [1, 0]],
      ...candidates.map(
        (candidate) =>
          [candidate.id, candidate.date === '2026-09-28' ? [0, 1] : [1, 0]] as [string, number[]]
      )
    ]);
    const ranked = rankSemanticCandidates(fixture.observation, candidates, vectors);
    expect(ranked.map((candidate) => candidate.id).sort()).toEqual(
      candidates.map((candidate) => candidate.id).sort()
    );
    expect(ranked[0].date).toBe('2026-09-28');
  });

  it('reports recall and false top-one suggestions separately for held-out cases', async () => {
    const embed = vi.fn(async (texts: string[]) => ({
      vectors: texts.map((_, index) => (index === 0 || index === 2 ? [1, 0] : [0, 1])),
      latencyMs: 12,
      promptTokens: 42,
      costUsd: 0.00000042
    }));
    const report = await runEvaluation(SYNTHETIC_CASES, embed);
    expect(report.splits.holdout.baseline).toMatchObject({
      evaluated: 4,
      knownMatches: 3,
      candidateRecallAt5: 1,
      top1Correct: 1,
      falseTop1: 3,
      noMatchCases: 1
    });
    expect(report.splits.holdout.semantic?.falseTop1).toBeGreaterThanOrEqual(0);
    expect(report.embedding?.requests).toBe(SYNTHETIC_CASES.length);
    expect(report.embedding?.observedCostUsd).toBeCloseTo(SYNTHETIC_CASES.length * 0.00000042);
    expect(embed).toHaveBeenCalledTimes(SYNTHETIC_CASES.length);
  });

  it('does not claim billed cost is complete if a response omits it', async () => {
    const report = await runEvaluation(SYNTHETIC_CASES.slice(0, 1), async (texts) => ({
      vectors: texts.map(() => [1, 0]),
      latencyMs: 9,
      promptTokens: 5,
      costUsd: null
    }));
    expect(report.embedding).toMatchObject({ observedCostUsd: null, costComplete: false });
  });

  it('sends only synthetic descriptions with deny routing and rejects malformed vectors', async () => {
    const fixture = SYNTHETIC_CASES[0];
    const body = buildEmbeddingRequest(['desayuno capuchino', 'cafeteria'], 'baai/bge-m3');
    expect(body).toMatchObject({ provider: { data_collection: 'deny' }, model: 'baai/bge-m3' });
    expect(JSON.stringify(body)).not.toContain(String(fixture.observation.amount));
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }], usage: { prompt_tokens: 2 } }),
          { status: 200 }
        )
    );
    const embed = createOpenRouterEmbedder({ apiKey: 'synthetic-test-key', fetchImpl });
    await expect(embed(['invented receipt'])).rejects.toThrow('Invalid embedding response');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('accepts indexed 1024-dimensional vectors and keeps missing cost unknown', async () => {
    const embedding = Array.from({ length: 1024 }, (_, index) => index / 1024);
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: embedding.map((value) => -value) },
              { index: 0, embedding }
            ],
            usage: { prompt_tokens: 17 }
          }),
          { status: 200 }
        )
    );
    const embed = createOpenRouterEmbedder({
      apiKey: 'synthetic-test-key',
      fetchImpl,
      now: () => 10
    });
    const result = await embed(['invented first', 'invented second']);
    expect(result.vectors[0]).toEqual(embedding);
    expect(result.promptTokens).toBe(17);
    expect(result.costUsd).toBeNull();
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body as string)).toMatchObject({
      input: ['invented first', 'invented second'],
      provider: { data_collection: 'deny' }
    });
  });

  it('does not invent a match when an amount and date gate excludes every candidate', async () => {
    const fixture = SYNTHETIC_CASES[0];
    const report = await runEvaluation(
      [
        {
          ...fixture,
          transactions: fixture.transactions.map((row) => ({ ...row, amount: row.amount + 1 }))
        }
      ],
      async (texts) => ({
        vectors: texts.map(() => [1, 0]),
        latencyMs: 1,
        promptTokens: 1,
        costUsd: 0
      })
    );
    expect(report.splits.development.semantic).toMatchObject({
      candidateRecallAt5: 0,
      falseTop1: 0
    });
  });
});
