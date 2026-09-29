import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AiUsageService } from '../../../src/services/supabase/ai-usage.service';

const URL = 'https://test.supabase.co';
const KEY = 'test-service-key';
const MODEL = 'deepseek/deepseek-v4.1-flash';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    statusText: status < 300 ? 'OK' : 'Error',
    headers: { 'Content-Type': 'application/json' }
  });
}

function stubFetch(handler: (url: string) => Response = () => jsonResponse([])): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      calls.push({
        url,
        method: options?.method ?? 'GET',
        headers: (options?.headers ?? {}) as Record<string, string>,
        body: options?.body ? JSON.parse(options.body as string) : null
      });
      return handler(url);
    })
  );
  return calls;
}

describe('AiUsageService', () => {
  let service: AiUsageService;
  const params = { userId: 'user-1', operation: 'parse_expense', model: MODEL };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    service = new AiUsageService(URL, KEY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('track', () => {
    it('records a succeeded event with metered usage and returns the result', async () => {
      const calls = stubFetch();

      const result = await service.track(params, async (meter) => {
        meter.record({ inputTokens: 1000, outputTokens: 100, costUsd: 0.00055 });
        return 'ok';
      });

      expect(result).toBe('ok');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/rest/v1/ai_usage_events?on_conflict=id');
      expect(calls[0].method).toBe('POST');
      expect(calls[0].headers.Prefer).toContain('resolution=ignore-duplicates');
      expect(calls[0].body).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        user_id: 'user-1',
        month: expect.stringMatching(/^\d{4}-\d{2}$/),
        operation: 'parse_expense',
        model: MODEL,
        status: 'succeeded',
        billed_calls: 1,
        input_tokens: 1000,
        output_tokens: 100,
        estimated_cost_micros: 550,
        cost_source: 'upstream'
      });
    });

    it('records a failed event and rethrows the original error', async () => {
      const calls = stubFetch();

      await expect(
        service.track(params, async (meter) => {
          meter.record({ inputTokens: 10, outputTokens: 0, costUsd: 0.000003 });
          throw new Error('bad json');
        })
      ).rejects.toThrow('bad json');

      expect(calls[0].body).toMatchObject({
        status: 'failed',
        billed_calls: 1,
        estimated_cost_micros: 3
      });
    });

    it('records zero-cost events when no upstream call happened (cache hit)', async () => {
      const calls = stubFetch();
      await service.track(params, async () => 'cached');
      expect(calls[0].body).toMatchObject({
        billed_calls: 0,
        estimated_cost_micros: 0,
        cost_source: 'none'
      });
    });

    it('never blocks or fails the request when telemetry storage fails', async () => {
      stubFetch(() => jsonResponse({ message: 'down' }, 503));
      await expect(service.track(params, async () => 'ok')).resolves.toBe('ok');
    });

    it('keeps the original error when telemetry storage also fails', async () => {
      stubFetch(() => jsonResponse({ message: 'down' }, 503));
      await expect(
        service.track(params, async () => {
          throw new Error('upstream');
        })
      ).rejects.toThrow('upstream');
    });

    it('buckets events by Colombia calendar month', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const calls = stubFetch();

      vi.setSystemTime(new Date('2026-10-01T04:59:00Z'));
      await service.track(params, async () => 'a');
      vi.setSystemTime(new Date('2026-10-01T05:00:00Z'));
      await service.track(params, async () => 'b');

      expect(calls.map((c) => c.body?.month)).toEqual(['2026-09', '2026-10']);
    });

    it('does not read plans, quotas or limits', async () => {
      const calls = stubFetch();
      await service.track(params, async () => 'ok');
      expect(calls.every((c) => c.url.includes('ai_usage_events'))).toBe(true);
    });
  });

  describe('getMonthlyReport', () => {
    it('reads the internal monthly view for a month', async () => {
      const rows = [{ user_id: 'user-1', month: '2026-09', estimated_cost_micros: 1000 }];
      const calls = stubFetch(() => jsonResponse(rows));

      expect(await service.getMonthlyReport('2026-09')).toEqual(rows);
      expect(calls[0].url).toContain('/rest/v1/ai_usage_monthly?month=eq.2026-09');
    });
  });

  describe('cleanupOldEvents', () => {
    it('deletes events older than 12 months', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
      const calls = stubFetch();

      await service.cleanupOldEvents();

      expect(calls[0].method).toBe('DELETE');
      expect(calls[0].url).toContain('/rest/v1/ai_usage_events?month=lt.2025-09');
    });
  });
});
