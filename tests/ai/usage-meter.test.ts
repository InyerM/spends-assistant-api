import { describe, expect, it } from 'vitest';
import { AiUsageMeter } from '../../src/ai/usage-meter';

describe('AiUsageMeter', () => {
  it('reports no upstream call', () => {
    expect(new AiUsageMeter().summary()).toEqual({
      billedCalls: 0,
      inputTokens: null,
      outputTokens: null,
      estimatedCostMicros: 0,
      costSource: 'none'
    });
  });

  it('records upstream costs in integer micro-USD', () => {
    const meter = new AiUsageMeter();
    meter.record({ inputTokens: 100, outputTokens: 20, costUsd: 0.0000012 });
    expect(meter.summary()).toEqual({
      billedCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
      estimatedCostMicros: 2,
      costSource: 'upstream'
    });
  });

  it('marks retries with missing usage as partial', () => {
    const meter = new AiUsageMeter();
    meter.record(null);
    meter.record({ inputTokens: 5, outputTokens: 2, costUsd: 0.000001 });
    expect(meter.summary()).toMatchObject({
      billedCalls: 2,
      estimatedCostMicros: 1,
      costSource: 'partial'
    });
  });

  it('does not guess cost from unknown model prices', () => {
    const meter = new AiUsageMeter();
    meter.record({ inputTokens: 5, outputTokens: 2 });
    expect(meter.summary()).toMatchObject({
      billedCalls: 1,
      inputTokens: 5,
      estimatedCostMicros: null,
      costSource: 'unknown'
    });
  });
});
