interface CompletionInput {
  apiKey: string;
  model: string;
  system: string;
  user: string;
}

interface CompletionResponse {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export async function completeJson<T>(input: CompletionInput): Promise<{
  data: T;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
}> {
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
      temperature: 0.1,
      max_tokens: 2048,
      provider: {
        zdr: true,
        data_collection: 'deny',
        max_price: { prompt: 0.4, completion: 1 }
      }
    })
  };

  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      ...request,
      signal: AbortSignal.timeout(30_000)
    });
    if (response.status !== 429 || attempt === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }

  // Upstream responses can contain private financial text. Keep errors generic.
  if (!response?.ok) throw new Error(`OpenRouter request failed (${response?.status ?? 0})`);

  const result = (await response.json()) as CompletionResponse;
  const choice = result.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('OpenRouter response truncated');
  if (!choice?.message?.content) throw new Error('OpenRouter returned no content');

  let data: T;
  try {
    data = JSON.parse(choice.message.content) as T;
  } catch {
    throw new Error('OpenRouter returned invalid JSON');
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
