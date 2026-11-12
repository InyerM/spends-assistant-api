import { BaseService } from './base.service';
import { OpenRouterError } from '../../ai/openrouter';
import { AiUsageMeter } from '../../ai/usage-meter';
import type { AiConsentScope } from './ai-consent.service';
import { AiConsentUnavailableError } from './ai-consent.service';

export interface TrackAiUsageParams {
  userId: string;
  operation:
    | 'financial_chat'
    | 'parse_expense'
    | 'generate_automation'
    | 'extract_document'
    | 'triage_forwarded_email'
    | 'classify_forwarded_purchase';
  model: string;
}

export interface AiUsageMonthlyRow {
  user_id: string;
  month: string;
  operation: string;
  model: string;
  events: number;
  failed_events: number;
  billed_calls: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_micros: number;
  unknown_cost_events: number;
}

function colombiaMonth(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  return `${year}-${month}`;
}

/** Recording is best effort and never controls a user request. */
export class AiUsageService extends BaseService {
  async requireConsent(_userId: string, _scope: AiConsentScope): Promise<void> {
    throw new AiConsentUnavailableError();
  }

  async track<T>(
    params: TrackAiUsageParams,
    fn: (meter: AiUsageMeter) => Promise<T>,
    _scope?: AiConsentScope
  ): Promise<T> {
    const meter = new AiUsageMeter();
    const correlationId = crypto.randomUUID();
    const startedAt = Date.now();
    try {
      const result = await fn(meter);
      await this.recordQuietly(params, meter, 'succeeded', correlationId);
      return result;
    } catch (error) {
      const errorClass =
        error instanceof OpenRouterError &&
        ['http', 'network', 'invalid_json', 'empty', 'truncated'].includes(error.reason)
          ? error.reason
          : 'unknown';
      console.error('[AiUsage] Operation failed', {
        correlationId,
        operation: params.operation,
        model: /^[a-zA-Z0-9][a-zA-Z0-9/_.:-]{0,127}$/u.test(params.model)
          ? params.model
          : 'unknown',
        errorClass,
        upstreamStatus:
          error instanceof OpenRouterError &&
          Number.isInteger(error.status) &&
          error.status >= 100 &&
          error.status <= 599
            ? error.status
            : null,
        durationMs: Math.max(0, Math.min(3_600_000, Date.now() - startedAt))
      });
      await this.recordQuietly(params, meter, 'failed', correlationId);
      throw error;
    }
  }

  async getMonthlyReport(month: string): Promise<AiUsageMonthlyRow[]> {
    const params = new URLSearchParams({ month: `eq.${month}` });
    return this.fetch<AiUsageMonthlyRow[]>(`/rest/v1/ai_usage_monthly?${params.toString()}`);
  }

  async cleanupOldEvents(): Promise<void> {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 12);
    const params = new URLSearchParams({ month: `lt.${colombiaMonth(cutoff)}` });
    await this.fetch<unknown>(`/rest/v1/ai_usage_events?${params.toString()}`, {
      method: 'DELETE'
    });
  }

  private async recordQuietly(
    params: TrackAiUsageParams,
    meter: AiUsageMeter,
    status: 'succeeded' | 'failed',
    correlationId: string
  ): Promise<void> {
    const summary = meter.summary();
    try {
      await this.fetch<unknown>('/rest/v1/ai_usage_events?on_conflict=id', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify({
          id: correlationId,
          user_id: params.userId,
          month: colombiaMonth(),
          operation: params.operation,
          model: params.model,
          status,
          billed_calls: summary.billedCalls,
          input_tokens: summary.inputTokens,
          output_tokens: summary.outputTokens,
          estimated_cost_micros: summary.estimatedCostMicros,
          cost_source: summary.costSource
        })
      });
    } catch {
      console.error('[AiUsage] Failed to record usage event');
    }
  }
}
