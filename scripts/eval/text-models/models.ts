import type { ModelCandidate } from './types';

/**
 * Candidates and list prices from docs/plans/2026-09-28-model-cost-comparison.md.
 * Prices are used for estimates and as the per-request price cap; recheck before a run.
 */
export const MODELS: ModelCandidate[] = [
  {
    id: 'deepseek/deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash (production default)',
    price: { input: 0.13, output: 0.52 },
    optional: false
  },
  {
    id: 'qwen/qwen3-vl-30b-a3b-instruct',
    label: 'Qwen3 VL 30B A3B Instruct',
    price: { input: 0.13, output: 0.52 },
    optional: false
  },
  {
    id: 'openai/gpt-5-mini',
    label: 'GPT-5 Mini',
    price: { input: 0.25, output: 2.0 },
    optional: true
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    label: 'Claude Haiku 4.5',
    price: { input: 1.0, output: 5.0 },
    optional: true
  }
];

export function selectModels(options: {
  ids?: string[];
  includeOptional: boolean;
}): ModelCandidate[] {
  if (options.ids?.length) {
    const unknown = options.ids.filter((id) => !MODELS.some((model) => model.id === id));
    if (unknown.length) throw new Error(`Unknown model id(s): ${unknown.join(', ')}`);
    return MODELS.filter((model) => options.ids?.includes(model.id));
  }
  return MODELS.filter((model) => options.includeOptional || !model.optional);
}

export function estimateCostUsd(
  model: ModelCandidate,
  promptTokens: number,
  completionTokens: number
): number {
  return (promptTokens * model.price.input + completionTokens * model.price.output) / 1_000_000;
}
