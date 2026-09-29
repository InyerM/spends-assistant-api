import { pickVerdict, scoreFixture, summarizeModel } from './scoring';
import type { Fixture, ModelCandidate, ModelSummary, Responder, Verdict } from './types';

export interface EvaluationResult {
  mode: 'offline' | 'live';
  referenceDate: string;
  fixtureCount: number;
  repeats: number;
  summaries: ModelSummary[];
  verdict: Verdict;
}

export async function runEvaluation(input: {
  mode: 'offline' | 'live';
  referenceDate: string;
  fixtures: Fixture[];
  models: ModelCandidate[];
  responder: Responder;
  repeats?: number;
}): Promise<EvaluationResult> {
  const repeats = Math.max(1, input.repeats ?? 1);

  // Models run in parallel; fixtures run one at a time per model so latency is not queue time.
  const summaries = await Promise.all(
    input.models.map(async (model) => {
      const scores = [];
      for (let round = 0; round < repeats; round++) {
        for (const fixture of input.fixtures) {
          scores.push(scoreFixture(fixture, await input.responder(fixture, model)));
        }
      }
      return summarizeModel(model, scores);
    })
  );

  return {
    mode: input.mode,
    referenceDate: input.referenceDate,
    fixtureCount: input.fixtures.length,
    repeats,
    summaries,
    verdict: pickVerdict(summaries)
  };
}
