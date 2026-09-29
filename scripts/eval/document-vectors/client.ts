import type { Embedder, EmbeddingResult } from './benchmark';

const ENDPOINT = 'https://openrouter.ai/api/v1/embeddings';
const DIMENSIONS = 1024;

export interface OpenRouterEmbedderOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

interface ProviderResponse {
  data?: Array<{ index?: number; embedding?: number[] }>;
  usage?: { prompt_tokens?: number; cost?: number };
}

export function buildEmbeddingRequest(input: string[], model = 'baai/bge-m3') {
  if (!input.length || input.some((text) => !text.trim()))
    throw new Error('Embedding input must be nonempty');
  return { model, input, encoding_format: 'float', provider: { data_collection: 'deny' } };
}

export function createOpenRouterEmbedder(options: OpenRouterEmbedderOptions): Embedder {
  if (!options.apiKey) throw new Error('OPENROUTER_API_KEY is required for live evaluation');
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => performance.now());
  return async (texts: string[]): Promise<EmbeddingResult> => {
    const started = now();
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'spends-synthetic-document-vector-eval'
      },
      body: JSON.stringify(buildEmbeddingRequest(texts)),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000)
    });
    // Provider errors may echo input, so never log or surface their response body.
    if (!response.ok) throw new Error(`OpenRouter embedding request failed (${response.status})`);
    let body: ProviderResponse;
    try {
      body = (await response.json()) as ProviderResponse;
    } catch {
      throw new Error('Invalid embedding response');
    }
    const rows = body.data;
    if (!rows || rows.length !== texts.length) throw new Error('Invalid embedding response');
    const vectors: number[][] = Array.from({ length: texts.length });
    for (const row of rows) {
      if (
        !Number.isInteger(row.index) ||
        (row.index ?? -1) < 0 ||
        (row.index ?? Infinity) >= texts.length ||
        !Array.isArray(row.embedding) ||
        row.embedding.length !== DIMENSIONS ||
        !row.embedding.every((value) => typeof value === 'number' && Number.isFinite(value)) ||
        vectors[row.index!]
      ) {
        throw new Error('Invalid embedding response');
      }
      vectors[row.index!] = row.embedding;
    }
    if (vectors.some((vector) => !vector)) throw new Error('Invalid embedding response');
    return {
      vectors,
      latencyMs: Math.round(now() - started),
      promptTokens: typeof body.usage?.prompt_tokens === 'number' ? body.usage.prompt_tokens : null,
      // Current public embedding schema does not promise cost; never infer billed USD from list price.
      costUsd: typeof body.usage?.cost === 'number' ? body.usage.cost : null
    };
  };
}
