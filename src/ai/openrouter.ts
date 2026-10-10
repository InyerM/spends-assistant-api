import type { AiUsageMeter } from './usage-meter';
interface CompletionInput {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  meter?: AiUsageMeter;
  maxOutputTokens?: number;
  recoverMalformedOutput?: boolean;
  publicWebSearch?: boolean;
  timeoutMs?: number;
  disableReasoning?: boolean;
}

export class OpenRouterError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: 'http' | 'network' | 'invalid_json' | 'empty' | 'truncated',
    public readonly stage?: 'envelope' | 'content'
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
    message?: {
      content?: string | null;
      annotations?: Array<{ type?: string; url_citation?: { url?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number | null };
}

export async function completeJson<T>(input: CompletionInput): Promise<{
  data: T;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
  citations?: string[];
}> {
  if (
    input.maxOutputTokens !== undefined &&
    (!Number.isInteger(input.maxOutputTokens) ||
      input.maxOutputTokens < 128 ||
      input.maxOutputTokens > 8192)
  )
    throw new Error('Invalid output token limit');
  if (!input.apiKey) throw new Error('OpenRouter API key is not configured');

  if (
    input.timeoutMs !== undefined &&
    (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 45000)
  )
    throw new Error('Invalid completion timeout');
  let maxTokens = input.maxOutputTokens ?? 2048;
  const payload = {
    model: input.model,
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.user }
    ],
    response_format: { type: 'json_object' },
    usage: { include: true },
    temperature: 0.1,
    ...(input.disableReasoning ? { reasoning: { enabled: false } } : {}),
    ...(input.publicWebSearch
      ? {
          tools: [
            {
              type: 'openrouter:web_search',
              parameters: {
                engine: 'exa',
                max_results: 3,
                max_total_results: 3,
                max_uses: 1,
                search_context_size: 'low'
              }
            }
          ]
        }
      : {}),
    provider: {
      zdr: true,
      data_collection: 'deny',
      max_price: { prompt: 0.4, completion: 1 }
    }
  };

  // Bound all recovery attempts; never retain or expose an upstream error body.
  const deadline = Date.now() + (input.timeoutMs ?? 45_000);
  const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
  for (let attempt = 0; attempt < (input.publicWebSearch ? 1 : 3); attempt++) {
    let response: Response | undefined;
    let result: CompletionResponse | undefined;
    let failure: OpenRouterError | undefined;
    let metered = false;
    try {
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ...payload, max_tokens: maxTokens }),
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
          if (!result || typeof result !== 'object' || Array.isArray(result))
            failure = new OpenRouterError(0, 'invalid_json', 'envelope');
          else if (result.error)
            failure = new OpenRouterError(
              Number.isInteger(result.error.code) ? result.error.code! : 502,
              'http'
            );
        } catch {
          failure = new OpenRouterError(0, 'invalid_json', 'envelope');
        }
      }
    }
    if (!failure && result) {
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
      metered = true;
      const choice = result.choices?.[0];
      if (choice?.finish_reason === 'length')
        failure = new OpenRouterError(0, 'truncated', 'content');
      else if (!choice?.message?.content) failure = new OpenRouterError(0, 'empty', 'content');
      else {
        try {
          const data = JSON.parse(choice.message.content) as T;
          const usage =
            result.usage?.prompt_tokens !== undefined &&
            result.usage.completion_tokens !== undefined
              ? {
                  prompt_tokens: result.usage.prompt_tokens,
                  completion_tokens: result.usage.completion_tokens
                }
              : null;
          const citations = [
            ...new Set(
              (choice.message.annotations ?? [])
                .filter((annotation) => annotation.type === 'url_citation')
                .map((annotation) => annotation.url_citation?.url)
                .filter((url): url is string => typeof url === 'string' && /^https:\/\//u.test(url))
            )
          ];
          return { data, usage, ...(input.publicWebSearch ? { citations } : {}) };
        } catch {
          failure = new OpenRouterError(0, 'invalid_json', 'content');
        }
      }
    }
    if (!metered) input.meter?.record(null);
    const outputFailure = failure?.reason === 'invalid_json' || failure?.reason === 'truncated';
    const retryable =
      failure?.reason === 'network' ||
      transientStatuses.has(failure?.status ?? 0) ||
      (input.recoverMalformedOutput === true && outputFailure);
    const retryAfter = Number(response?.headers.get('Retry-After'));
    const delay =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * (attempt + 1);
    if (!retryable || input.publicWebSearch || attempt === 2 || Date.now() + delay >= deadline) {
      throw failure ?? new OpenRouterError(0, 'network');
    }
    if (failure?.reason === 'truncated') maxTokens = Math.min(maxTokens * 2, 8192);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (Date.now() >= deadline) throw failure ?? new OpenRouterError(0, 'network');
  }
  throw new OpenRouterError(0, 'network');
}
