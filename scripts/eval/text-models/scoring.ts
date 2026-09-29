import { estimateCostUsd } from './models';
import type {
  CallResult,
  ExpectedValue,
  Fixture,
  FixtureCategory,
  FixtureScore,
  ModelCandidate,
  ModelSummary,
  ScoredField,
  Verdict
} from './types';

/** Same acceptance rules parseExpense() applies before a result reaches the database. */
export function isSchemaValid(data: Record<string, unknown>): boolean {
  if (typeof data.is_transaction !== 'boolean') return false;
  if (!data.is_transaction) return true;
  return (
    typeof data.amount === 'number' &&
    Number.isFinite(data.amount) &&
    data.amount > 0 &&
    typeof data.description === 'string' &&
    data.description.trim().length > 0 &&
    typeof data.category === 'string' &&
    data.category.length > 0
  );
}

function normalize(value: unknown): string | number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return value;
  return String(value).trim().toLowerCase();
}

export function fieldMatches(
  field: ScoredField,
  actual: unknown,
  expected: ExpectedValue | ExpectedValue[]
): boolean {
  const options = Array.isArray(expected) ? expected : [expected];
  const got = normalize(actual);
  return options.some((option) => {
    const want = normalize(option);
    if (field === 'amount') {
      return typeof got === 'number' && typeof want === 'number' && Math.abs(got - want) < 1;
    }
    return got === want;
  });
}

export function scoreFixture(fixture: Fixture, result: CallResult): FixtureScore {
  const expectedFields = Object.entries(fixture.expected.fields ?? {}) as Array<
    [ScoredField, ExpectedValue | ExpectedValue[]]
  >;
  const base = {
    fixtureId: fixture.id,
    category: fixture.category,
    expectedTransaction: fixture.expected.is_transaction,
    fieldsTotal: expectedFields.length,
    latencyMs: result.latencyMs,
    usage: result.usage,
    error: result.error
  };

  if (!result.data) {
    return {
      ...base,
      jsonValid: false,
      schemaValid: false,
      predictedTransaction: null,
      fieldsCorrect: 0,
      mismatchedFields: [`call:${result.error ?? 'unknown'}`]
    };
  }

  const data = result.data;
  const schemaValid = isSchemaValid(data);
  const predictedTransaction =
    typeof data.is_transaction === 'boolean' ? data.is_transaction : null;
  const mismatchedFields: string[] = [];
  if (!schemaValid) mismatchedFields.push('schema');
  if (predictedTransaction !== fixture.expected.is_transaction) {
    mismatchedFields.push('is_transaction');
  }

  let fieldsCorrect = 0;
  // Field values only count when the model agreed this is a transaction.
  if (predictedTransaction === true) {
    for (const [field, expected] of expectedFields) {
      if (fieldMatches(field, data[field], expected)) fieldsCorrect++;
      else mismatchedFields.push(field);
    }
  } else if (expectedFields.length) {
    mismatchedFields.push(...expectedFields.map(([field]) => field));
  }

  return {
    ...base,
    jsonValid: true,
    schemaValid,
    predictedTransaction,
    fieldsCorrect,
    mismatchedFields
  };
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function summarizeModel(model: ModelCandidate, scores: FixtureScore[]): ModelSummary {
  const runs = scores.length;
  const negatives = scores.filter((score) => !score.expectedTransaction);
  const positives = scores.filter((score) => score.expectedTransaction);
  const fieldsTotal = scores.reduce((sum, score) => sum + score.fieldsTotal, 0);
  const fieldsCorrect = scores.reduce((sum, score) => sum + score.fieldsCorrect, 0);

  const byCategory: Partial<Record<FixtureCategory, { total: number; correct: number }>> = {};
  for (const score of scores) {
    // Non-transaction fixtures have no fields, so their "accuracy" is detection.
    const total = score.fieldsTotal || 1;
    const correct = score.fieldsTotal
      ? score.fieldsCorrect
      : Number(score.predictedTransaction === score.expectedTransaction);
    const bucket = (byCategory[score.category] ??= { total: 0, correct: 0 });
    bucket.total += total;
    bucket.correct += correct;
  }
  const fieldAccuracyByCategory: Partial<Record<FixtureCategory, number>> = {};
  for (const [category, bucket] of Object.entries(byCategory)) {
    if (bucket)
      fieldAccuracyByCategory[category as FixtureCategory] = bucket.correct / bucket.total;
  }

  const withUsage = scores.filter((score) => score.usage);
  const observed = withUsage.filter((score) => score.usage?.costUsd !== null);
  const estimatedCostUsd = withUsage.reduce(
    (sum, score) =>
      sum +
      estimateCostUsd(model, score.usage?.promptTokens ?? 0, score.usage?.completionTokens ?? 0),
    0
  );
  const observedCostUsd = observed.length
    ? observed.reduce((sum, score) => sum + (score.usage?.costUsd ?? 0), 0)
    : null;
  const costBasis = observedCostUsd ?? estimatedCostUsd;
  const costRuns = observedCostUsd !== null ? observed.length : withUsage.length;

  const latencies = scores.map((score) => score.latencyMs);

  return {
    modelId: model.id,
    label: model.label,
    runs,
    jsonValidRate: rate(scores.filter((s) => s.jsonValid).length, runs) ?? 0,
    schemaValidRate: rate(scores.filter((s) => s.schemaValid).length, runs) ?? 0,
    detectionAccuracy:
      rate(scores.filter((s) => s.predictedTransaction === s.expectedTransaction).length, runs) ??
      0,
    falseTransactionRate: rate(
      negatives.filter((s) => s.predictedTransaction === true).length,
      negatives.length
    ),
    missedTransactionRate: rate(
      positives.filter((s) => s.predictedTransaction !== true).length,
      positives.length
    ),
    fieldAccuracy: rate(fieldsCorrect, fieldsTotal),
    fieldAccuracyByCategory,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    observedCostUsd,
    estimatedCostUsd,
    costCoverage: rate(observed.length, runs) ?? 0,
    costPer1kUsd: costRuns ? (costBasis / costRuns) * 1000 : 0,
    failures: scores
      .filter((score) => score.mismatchedFields.length)
      .map((score) => ({ fixtureId: score.fixtureId, reasons: score.mismatchedFields }))
  };
}

/** Composite quality: field accuracy, penalized for invalid output and false transactions. */
export function qualityScore(summary: ModelSummary): number {
  return (
    (summary.fieldAccuracy ?? 0) * 0.5 +
    summary.detectionAccuracy * 0.3 +
    summary.schemaValidRate * 0.2 -
    (summary.falseTransactionRate ?? 0) * 0.2
  );
}

/**
 * Picks a winner only when the quality gap beats the sampling noise of a small fixture set.
 * The margin is one standard error of a proportion at p=0.5 (0.5 / sqrt(runs)), capped at 10 points.
 */
export function pickVerdict(summaries: ModelSummary[]): Verdict {
  if (!summaries.length)
    return { winner: null, uncertain: true, reason: 'No models were evaluated.' };
  if (summaries.length === 1) {
    return {
      winner: summaries[0].modelId,
      uncertain: true,
      reason: 'Only one model was evaluated; there is nothing to compare against.'
    };
  }

  const ranked = [...summaries].sort((a, b) => qualityScore(b) - qualityScore(a));
  const [best, runnerUp] = ranked;
  const runs = Math.min(best.runs, runnerUp.runs);
  const margin = Math.min(0.1, 0.5 / Math.sqrt(Math.max(1, runs)));
  const gap = qualityScore(best) - qualityScore(runnerUp);

  if (best.jsonValidRate < 0.95) {
    return {
      winner: best.modelId,
      uncertain: true,
      reason: `Top model's JSON validity is ${formatPercent(best.jsonValidRate)}, below the 95% bar.`
    };
  }
  if (gap < margin) {
    const cheaper = best.costPer1kUsd <= runnerUp.costPer1kUsd ? best : runnerUp;
    return {
      winner: cheaper.modelId,
      uncertain: true,
      reason: `Quality gap ${formatPoints(gap)} is within the ${formatPoints(margin)} noise margin; preferring the cheaper model.`
    };
  }
  return {
    winner: best.modelId,
    uncertain: false,
    reason: `Quality lead of ${formatPoints(gap)} over ${runnerUp.modelId} exceeds the ${formatPoints(margin)} noise margin.`
  };
}

export function formatPercent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatPoints(value: number): string {
  return `${(value * 100).toFixed(1)} pts`;
}
