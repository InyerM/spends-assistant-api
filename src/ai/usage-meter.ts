/** Aggregate metadata for OpenRouter requests. No prompts, images, or responses are retained. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export type CostSource = 'upstream' | 'partial' | 'unknown' | 'none';

export class AiUsageMeter {
  private calls = 0;
  private knownTokens = 0;
  private knownCosts = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private costMicros = 0;

  record(usage: TokenUsage | null): void {
    this.calls++;
    if (!usage) return;
    if (
      Number.isSafeInteger(usage.inputTokens) &&
      usage.inputTokens >= 0 &&
      Number.isSafeInteger(usage.outputTokens) &&
      usage.outputTokens >= 0
    ) {
      this.knownTokens++;
      this.inputTokens += usage.inputTokens;
      this.outputTokens += usage.outputTokens;
    }
    if (usage.costUsd !== undefined && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) {
      this.knownCosts++;
      this.costMicros += Math.ceil(usage.costUsd * 1_000_000);
    }
  }

  summary(): {
    billedCalls: number;
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedCostMicros: number | null;
    costSource: CostSource;
  } {
    const costSource: CostSource =
      this.calls === 0
        ? 'none'
        : this.knownCosts === 0
          ? 'unknown'
          : this.knownCosts < this.calls
            ? 'partial'
            : 'upstream';
    return {
      billedCalls: this.calls,
      inputTokens: this.knownTokens ? this.inputTokens : null,
      outputTokens: this.knownTokens ? this.outputTokens : null,
      estimatedCostMicros: costSource === 'unknown' ? null : this.costMicros,
      costSource
    };
  }
}
