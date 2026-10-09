import type { AiUsageMeter } from './usage-meter';
interface CompletionInput {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  meter?: AiUsageMeter;
  maxOutputTokens?: number;
}

export class OpenRouterError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: 'http' | 'network' | 'invalid_json' | 'empty' | 'truncated'
  ) {
    super(
      reason === 'http'
        ? `OpenRouter request failed (${status})`
        : `OpenRouter ${reason === 'invalid_json' ? 'returned invalid JSON' : reason === 'empty' ? 'returned no content' : reason === 'truncated' ? 'response truncated' : 'network request failed'}`
    );
    this.name = 'OpenRouterError';
  }
}

interface CompletionResponse {
  error?: { code?: number };
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number | null };
}

export async function completeJson<T>(input: CompletionInput): Promise<{
  data: T;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
}> {
  if (
    input.maxOutputTokens !== undefined &&
    (!Number.isInteger(input.maxOutputTokens) ||
      input.maxOutputTokens < 128 ||
      input.maxOutputTokens > 8192)
  )
    throw new Error('Invalid output token limit');
  if (!input.apiKey) throw new Error('OpenRouter API key is not configured');

  const request: RequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: input.model,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user }
      ],
      response_format: { type: 'json_object' },
      usage: { include: true },
      temperature: 0.1,
      max_tokens: input.maxOutputTokens ?? 2048,
      provider: {
        zdr: true,
        data_collection: 'deny',
        max_price: { prompt: 0.4, completion: 1 }
      }
    })
  };

  // Bound total retry latency; never retain or expose an upstream error body.
  const deadline = Date.now() + 45_000;
  const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
  let result: CompletionResponse | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response | undefined;
    let failure: OpenRouterError | undefined;
    try {
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        ...request,
        signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now())))
      });
    } catch {
      failure = new OpenRouterError(0, 'network');
    }
    if (response) {
      if (!response.ok) {
        failure = new OpenRouterError(response.status, 'http');
      } else {
        try {
          result = (await response.json()) as CompletionResponse;
          if (!result || typeof result !== 'object')
            failure = new OpenRouterError(0, 'invalid_json');
          else if (result.error)
            failure = new OpenRouterError(
              Number.isInteger(result.error.code) ? result.error.code! : 502,
              'http'
            );
        } catch {
          failure = new OpenRouterError(0, 'invalid_json');
        }
      }
    }
    if (!failure && result) break;
    input.meter?.record(null);
    const retryable = failure?.reason === 'network' || transientStatuses.has(failure?.status ?? 0);
    const retryAfter = Number(response?.headers.get('Retry-After'));
    const delay =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * (attempt + 1);
    if (!retryable || attempt === 2 || Date.now() + delay >= deadline) {
      throw failure ?? new OpenRouterError(0, 'network');
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    result = undefined;
  }
  if (!result) throw new OpenRouterError(0, 'network');
  const rawUsage = result.usage;
  input.meter?.record(
    rawUsage &&
      Number.isSafeInteger(rawUsage.prompt_tokens) &&
      Number.isSafeInteger(rawUsage.completion_tokens)
      ? {
          inputTokens: rawUsage.prompt_tokens!,
          outputTokens: rawUsage.completion_tokens!,
          costUsd: rawUsage.cost ?? undefined
        }
      : null
  );
  const choice = result.choices?.[0];
  if (choice?.finish_reason === 'length') throw new OpenRouterError(0, 'truncated');
  if (!choice?.message?.content) throw new OpenRouterError(0, 'empty');

  let data: T;
  try {
    data = JSON.parse(choice.message.content) as T;
  } catch {
    throw new OpenRouterError(0, 'invalid_json');
  }

  const usage =
    result.usage?.prompt_tokens !== undefined && result.usage.completion_tokens !== undefined
      ? {
          prompt_tokens: result.usage.prompt_tokens,
          completion_tokens: result.usage.completion_tokens
        }
      : null;

  return { data, usage };
}
