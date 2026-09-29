import { buildSystemPrompt } from '../../../src/constants/parse-expens-system-prompt';
import { REFERENCE_DATE, REFERENCE_TIME } from './fixtures';
import type { CallResult, Fixture, ModelCandidate, Responder } from './types';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

export interface LiveResponderOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Mirrors the production request in src/ai/openrouter.ts (same prompt, temperature, JSON mode,
 * and privacy routing) but pins the clock, asks for usage cost, and never retries so latency
 * and cost stay per-attempt. It is a separate client so evaluation cannot alter production.
 */
export function buildRequestBody(fixture: Fixture, model: ModelCandidate): Record<string, unknown> {
  return {
    model: model.id,
    messages: [
      { role: 'system', content: buildSystemPrompt(REFERENCE_DATE, REFERENCE_TIME) },
      { role: 'user', content: `Input to parse: ${fixture.text}` }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: 2048,
    usage: { include: true },
    provider: {
      ...(model.id.startsWith('qwen/') ? {} : { zdr: true }),
      data_collection: 'deny',
      max_price: { prompt: model.price.input, completion: model.price.output }
    }
  };
}

export function createLiveResponder(options: LiveResponderOptions): Responder {
  if (!options.apiKey) throw new Error('OPENROUTER_API_KEY is required for live runs');
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? ((): number => performance.now());
  const timeoutMs = options.timeoutMs ?? 30_000;

  return async (fixture, model): Promise<CallResult> => {
    const started = now();
    const elapsed = (): number => Math.round(now() - started);
    let response: Response;
    try {
      response = await fetchImpl(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'spends-text-model-eval'
        },
        body: JSON.stringify(buildRequestBody(fixture, model)),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return {
        latencyMs: elapsed(),
        usage: null,
        data: null,
        error: timedOut ? 'timeout' : 'network'
      };
    }

    if (!response.ok) {
      // Drop the body: provider errors can echo the prompt.
      return {
        latencyMs: elapsed(),
        usage: null,
        data: null,
        error: 'http',
        status: response.status
      };
    }

    let body: OpenRouterResponse;
    try {
      body = (await response.json()) as OpenRouterResponse;
    } catch {
      return { latencyMs: elapsed(), usage: null, data: null, error: 'invalid_json' };
    }
    const latencyMs = elapsed();
    const usage =
      body.usage?.prompt_tokens !== undefined && body.usage.completion_tokens !== undefined
        ? {
            promptTokens: body.usage.prompt_tokens,
            completionTokens: body.usage.completion_tokens,
            costUsd: typeof body.usage.cost === 'number' ? body.usage.cost : null
          }
        : null;

    const choice = body.choices?.[0];
    if (choice?.finish_reason === 'length') {
      return { latencyMs, usage, data: null, error: 'truncated' };
    }
    const content = choice?.message?.content;
    if (!content) return { latencyMs, usage, data: null, error: 'empty' };

    try {
      const parsed: unknown = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { latencyMs, usage, data: null, error: 'invalid_json' };
      }
      return { latencyMs, usage, data: parsed as Record<string, unknown>, error: null };
    } catch {
      return { latencyMs, usage, data: null, error: 'invalid_json' };
    }
  };
}

/**
 * Offline responder that answers with each fixture's expected values. It exercises scoring and
 * reporting end to end; a perfect score proves the harness, not any model.
 */
export function createOracleResponder(): Responder {
  return async (fixture): Promise<CallResult> => {
    const data: Record<string, unknown> = {
      is_transaction: fixture.expected.is_transaction,
      skip_reason: fixture.expected.is_transaction ? null : 'informational',
      amount: 0,
      description: fixture.expected.is_transaction ? 'synthetic' : '',
      category: 'missing',
      bank: 'other',
      payment_type: 'cash',
      source: 'manual',
      confidence: 100
    };
    for (const [field, value] of Object.entries(fixture.expected.fields ?? {})) {
      data[field] = Array.isArray(value) ? value[0] : value;
    }
    return {
      latencyMs: 0,
      usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
      data,
      error: null
    };
  };
}
