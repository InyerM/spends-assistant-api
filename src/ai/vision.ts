export type DocumentImageType =
  | 'receipt'
  | 'bank_screenshot'
  | 'sms_screenshot'
  | 'statement'
  | 'other';

export interface ImageObservation {
  amount: number | null;
  currency: string | null;
  occurred_at: string | null;
  description: string;
  counterparty: string | null;
  reference: string | null;
  source_excerpt: string;
  confidence: number;
}

export interface ImageExtractionDraft {
  document_type: DocumentImageType;
  observations: ImageObservation[];
}

interface ExtractionInput {
  apiKey: string;
  imageDataUrl: string;
  escalate?: boolean;
}

interface VisionResponse {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

const DEFAULT_MODEL = 'qwen/qwen3-vl-30b-a3b-instruct';
const ESCALATION_MODEL = 'qwen/qwen3-vl-235b-a22b-instruct';
const MAX_DATA_URL_LENGTH = 8_000_000;
const DOCUMENT_TYPES: DocumentImageType[] = [
  'receipt',
  'bank_screenshot',
  'sms_screenshot',
  'statement',
  'other'
];

const observationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    amount: { type: ['number', 'null'] },
    currency: { type: ['string', 'null'] },
    occurred_at: { type: ['string', 'null'] },
    description: { type: 'string' },
    counterparty: { type: ['string', 'null'] },
    reference: { type: ['string', 'null'] },
    source_excerpt: { type: 'string' },
    confidence: { type: 'number' }
  },
  required: [
    'amount',
    'currency',
    'occurred_at',
    'description',
    'counterparty',
    'reference',
    'source_excerpt',
    'confidence'
  ]
} as const;

const extractionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    document_type: { type: 'string', enum: DOCUMENT_TYPES },
    observations: { type: 'array', items: observationSchema }
  },
  required: ['document_type', 'observations']
} as const;

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function validateDraft(value: unknown): ImageExtractionDraft {
  if (!value || typeof value !== 'object') throw new Error('Invalid vision response');
  const draft = value as Partial<ImageExtractionDraft>;
  if (!DOCUMENT_TYPES.includes(draft.document_type as DocumentImageType)) {
    throw new Error('Invalid vision response');
  }
  if (!Array.isArray(draft.observations) || draft.observations.length > 50) {
    throw new Error('Invalid vision response');
  }

  for (const item of draft.observations) {
    if (!item || typeof item !== 'object') throw new Error('Invalid vision response');
    const observation = item as Partial<ImageObservation>;
    if (
      (observation.amount !== null &&
        (typeof observation.amount !== 'number' ||
          !Number.isFinite(observation.amount) ||
          observation.amount <= 0)) ||
      !isNullableString(observation.currency) ||
      !isNullableString(observation.occurred_at) ||
      typeof observation.description !== 'string' ||
      !isNullableString(observation.counterparty) ||
      !isNullableString(observation.reference) ||
      typeof observation.source_excerpt !== 'string' ||
      typeof observation.confidence !== 'number' ||
      !Number.isFinite(observation.confidence) ||
      observation.confidence < 0 ||
      observation.confidence > 1
    ) {
      throw new Error('Invalid vision response');
    }
  }

  return draft as ImageExtractionDraft;
}

export async function extractImageObservations(input: ExtractionInput): Promise<{
  draft: ImageExtractionDraft;
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number; cost: number | null } | null;
}> {
  if (!input.apiKey) throw new Error('OpenRouter API key is not configured');
  if (input.imageDataUrl.length > MAX_DATA_URL_LENGTH) throw new Error('Image too large');
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(input.imageDataUrl)) {
    throw new Error('Unsupported image data');
  }

  const model = input.escalate ? ESCALATION_MODEL : DEFAULT_MODEL;
  let response: Response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'Extract only visible financial facts from the image. Return one observation per distinct movement, including multiple receipts in one image. Never invent missing fields. If there is no movement, return an empty observations array.'
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Classify this image and extract draft financial observations.'
              },
              { type: 'image_url', image_url: { url: input.imageDataUrl } }
            ]
          }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'financial_image_observations',
            strict: true,
            schema: extractionSchema
          }
        },
        usage: { include: true },
        temperature: 0,
        max_tokens: 2048,
        provider: {
          zdr: true,
          data_collection: 'deny',
          max_price: { prompt: 0.4, completion: 1 }
        }
      }),
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    throw new Error('Vision request failed');
  }

  // Upstream bodies can include private image content. Never include them in errors.
  if (!response.ok) throw new Error(`Vision request failed (${response.status})`);

  let payload: VisionResponse;
  try {
    payload = (await response.json()) as VisionResponse;
  } catch {
    throw new Error('Invalid vision response');
  }

  const choice = payload.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('Vision response truncated');
  if (!choice?.message?.content) throw new Error('Invalid vision response');

  let data: unknown;
  try {
    data = JSON.parse(choice.message.content);
  } catch {
    throw new Error('Invalid vision response');
  }

  const draft = validateDraft(data);
  const usage =
    payload.usage?.prompt_tokens !== undefined &&
    payload.usage.completion_tokens !== undefined &&
    Number.isFinite(payload.usage.prompt_tokens) &&
    Number.isFinite(payload.usage.completion_tokens)
      ? {
          prompt_tokens: payload.usage.prompt_tokens,
          completion_tokens: payload.usage.completion_tokens,
          cost:
            typeof payload.usage.cost === 'number' &&
            Number.isFinite(payload.usage.cost) &&
            payload.usage.cost >= 0
              ? payload.usage.cost
              : null
        }
      : null;

  return { draft, model, usage };
}
