import type { SyntheticCase, SyntheticObservation, SyntheticTransaction } from './fixtures';

export interface EmbeddingResult {
  vectors: number[][];
  latencyMs: number;
  promptTokens: number | null;
  costUsd: number | null;
}
export type Embedder = (texts: string[]) => Promise<EmbeddingResult>;

interface Candidate extends SyntheticTransaction {
  daysApart: number;
  referenceHint: boolean;
  descriptionHint: boolean;
}

const DAY_MS = 86_400_000;
const normalized = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
const tokens = (value: string): Set<string> =>
  new Set(normalized(value).match(/[a-z0-9]{3,}/g) ?? []);
const cents = (value: number): number => Math.round(value * 100);

function day(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
    ? parsed
    : null;
}

/** Mirrors the web route's exact-amount, +/- three-day candidate gate and tie-breakers. */
export function baselineCandidates(
  observation: SyntheticObservation,
  transactions: SyntheticTransaction[]
): Candidate[] {
  const observedDay = day(observation.date);
  if (!Number.isFinite(observation.amount) || observation.amount <= 0 || observedDay === null)
    return [];
  const observationWords = tokens(`${observation.description} ${observation.counterparty}`);
  const reference = normalized(observation.reference ?? '').replace(/[^a-z0-9]/g, '');
  return transactions
    .flatMap((transaction) => {
      const transactionDay = day(transaction.date);
      if (transactionDay === null || cents(transaction.amount) !== cents(observation.amount))
        return [];
      const daysApart = Math.abs(transactionDay - observedDay) / DAY_MS;
      if (daysApart > 3) return [];
      const descriptionHint = [...tokens(transaction.description)].some((word) =>
        observationWords.has(word)
      );
      const referenceHint =
        reference.length >= 5 &&
        normalized(`${transaction.rawText} ${transaction.description}`)
          .replace(/[^a-z0-9]/g, '')
          .includes(reference);
      return [{ ...transaction, daysApart, referenceHint, descriptionHint }];
    })
    .sort(
      (a, b) =>
        a.daysApart - b.daysApart ||
        Number(b.referenceHint) - Number(a.referenceHint) ||
        Number(b.descriptionHint) - Number(a.descriptionHint) ||
        a.id.localeCompare(b.id)
    );
}

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) throw new Error('Invalid embedding dimensions');
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    aa += a[index] * a[index];
    bb += b[index] * b[index];
  }
  return aa > 0 && bb > 0 ? dot / Math.sqrt(aa * bb) : -1;
}

/** Semantic similarity breaks only equal-date, equal-reference ties; it never adds a candidate. */
export function rankSemanticCandidates(
  observation: SyntheticObservation,
  candidates: Candidate[],
  vectors: Map<string, number[]>
): Candidate[] {
  const queryVector = vectors.get(observation.id);
  if (!queryVector) throw new Error('Missing query embedding');
  return [...candidates].sort((a, b) => {
    const aVector = vectors.get(a.id);
    const bVector = vectors.get(b.id);
    if (!aVector || !bVector) throw new Error('Missing candidate embedding');
    return (
      a.daysApart - b.daysApart ||
      Number(b.referenceHint) - Number(a.referenceHint) ||
      cosine(queryVector, bVector) - cosine(queryVector, aVector) ||
      Number(b.descriptionHint) - Number(a.descriptionHint) ||
      a.id.localeCompare(b.id)
    );
  });
}

interface MatchSummary {
  evaluated: number;
  knownMatches: number;
  candidateRecallAt5: number;
  top1Correct: number;
  falseTop1: number;
  noMatchCases: number;
}

function summarize(cases: SyntheticCase[], rankings: Map<string, string[]>): MatchSummary {
  let knownMatches = 0,
    retrieved = 0,
    top1Correct = 0,
    falseTop1 = 0,
    noMatchCases = 0;
  for (const fixture of cases) {
    const ranked = rankings.get(fixture.id) ?? [];
    if (fixture.expectedTransactionId === null) noMatchCases++;
    else {
      knownMatches++;
      if (ranked.slice(0, 5).includes(fixture.expectedTransactionId)) retrieved++;
    }
    if (ranked[0] === fixture.expectedTransactionId) top1Correct++;
    else if (ranked.length > 0) falseTop1++;
  }
  return {
    evaluated: cases.length,
    knownMatches,
    candidateRecallAt5: knownMatches ? retrieved / knownMatches : 0,
    top1Correct,
    falseTop1,
    noMatchCases
  };
}

export async function runEvaluation(cases: SyntheticCase[], embed?: Embedder) {
  const baseline = new Map<string, string[]>();
  const semantic = new Map<string, string[]>();
  const measurements: EmbeddingResult[] = [];
  for (const fixture of cases) {
    const candidates = baselineCandidates(fixture.observation, fixture.transactions);
    baseline.set(
      fixture.id,
      candidates.map((candidate) => candidate.id)
    );
    if (!embed) continue;
    const texts = [
      `${fixture.observation.description} ${fixture.observation.counterparty}`.trim(),
      ...candidates.map((candidate) => candidate.description)
    ];
    const result = await embed(texts);
    if (result.vectors.length !== texts.length) throw new Error('Invalid embedding response');
    measurements.push(result);
    const vectors = new Map<string, number[]>([
      [fixture.observation.id, result.vectors[0]],
      ...candidates.map(
        (candidate, index) => [candidate.id, result.vectors[index + 1]] as [string, number[]]
      )
    ]);
    semantic.set(
      fixture.id,
      rankSemanticCandidates(fixture.observation, candidates, vectors).map(
        (candidate) => candidate.id
      )
    );
  }
  const split = (name: 'development' | 'holdout') => {
    const selected = cases.filter((fixture) => fixture.split === name);
    return {
      baseline: summarize(selected, baseline),
      semantic: embed ? summarize(selected, semantic) : null
    };
  };
  const costComplete = measurements.every((item) => item.costUsd !== null);
  return {
    mode: embed ? 'live' : 'baseline_only',
    splits: { development: split('development'), holdout: split('holdout') },
    embedding: embed
      ? {
          requests: measurements.length,
          totalLatencyMs: measurements.reduce((sum, item) => sum + item.latencyMs, 0),
          meanLatencyMs: measurements.length
            ? Math.round(
                measurements.reduce((sum, item) => sum + item.latencyMs, 0) / measurements.length
              )
            : 0,
          observedPromptTokens: measurements.every((item) => item.promptTokens !== null)
            ? measurements.reduce((sum, item) => sum + (item.promptTokens ?? 0), 0)
            : null,
          observedCostUsd: costComplete
            ? measurements.reduce((sum, item) => sum + (item.costUsd ?? 0), 0)
            : null,
          costComplete
        }
      : null
  };
}
