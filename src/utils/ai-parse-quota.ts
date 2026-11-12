import type { UsageService } from '../services/supabase/usage.service';

export class AiParseQuotaExceededError extends Error {
  constructor(
    readonly used: number,
    readonly limit: number
  ) {
    super('Parse limit reached');
  }
}

export class AiParseQuotaUnavailableError extends Error {
  constructor() {
    super('AI quota unavailable');
  }
}

export async function reserveAiParse(
  usage: Pick<UsageService, 'incrementAiParses'>,
  userId: string
): Promise<void> {
  let allowance;
  try {
    allowance = await usage.incrementAiParses(userId);
  } catch {
    throw new AiParseQuotaUnavailableError();
  }
  if (!allowance.allowed) throw new AiParseQuotaExceededError(allowance.used, allowance.limit);
}

export function aiParseQuotaErrorResponse(error: unknown): Response | null {
  if (error instanceof AiParseQuotaExceededError) {
    return Response.json(
      { error: error.message, code: 'PARSE_LIMIT_REACHED', used: error.used, limit: error.limit },
      { status: 429, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }
  if (error instanceof AiParseQuotaUnavailableError) {
    return Response.json(
      { error: error.message, code: 'AI_QUOTA_UNAVAILABLE' },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }
  return null;
}
