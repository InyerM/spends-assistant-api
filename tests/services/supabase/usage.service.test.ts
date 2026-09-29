import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UsageService } from '../../../src/services/supabase/usage.service';

const URL = 'https://test.supabase.co';
const KEY = 'test-service-key';

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetchByUrl(routes: Record<string, unknown>): void {
  const patchBodies: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method === 'PATCH') {
        patchBodies.push(options.body as string);
      }
      for (const [pattern, data] of Object.entries(routes)) {
        if (url.includes(pattern)) return jsonResponse(data);
      }
      return jsonResponse([]);
    }),
  );
  (globalThis as Record<string, unknown>).__patchBodies = patchBodies;
}

const makeUsage = (overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id: 'usage-1',
  user_id: 'user-1',
  month: new Date().toISOString().slice(0, 7),
  ai_parses_used: 5,
  ai_parses_limit: 15,
  transactions_count: 0,
  transactions_limit: 50,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('UsageService', () => {
  let service: UsageService;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new UsageService(URL, KEY);
  });

  describe('getOrCreateMonthlyUsage', () => {
    it('returns existing usage record when found', async () => {
      const existing = makeUsage();
      mockFetchByUrl({ usage_tracking: [existing] });

      const result = await service.getOrCreateMonthlyUsage('user-1');
      expect(result).toEqual(existing);
      expect(result.ai_parses_used).toBe(5);
    });

    it('creates new record with dynamic app_settings limits when none exists', async () => {
      const created = makeUsage({ id: 'usage-new', ai_parses_used: 0, ai_parses_limit: 20 });
      let callCount = 0;

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          callCount++;
          if (url.includes('usage_tracking') && callCount === 1) {
            return jsonResponse([]);
          }
          if (url.includes('free_ai_parses_limit')) {
            return jsonResponse([{ key: 'free_ai_parses_limit', value: 20 }]);
          }
          if (url.includes('free_transactions_limit')) {
            return jsonResponse([{ key: 'free_transactions_limit', value: 100 }]);
          }
          // POST usage_tracking
          return jsonResponse([created]);
        }),
      );

      const result = await service.getOrCreateMonthlyUsage('user-1');
      expect(result.ai_parses_used).toBe(0);
    });
  });

  describe('incrementAiParses', () => {
    it.each([
      [{ allowed: true, used: 6, limit: 15 }],
      [{ allowed: false, used: 15, limit: 15 }],
      [{ allowed: true, used: 101, limit: -1 }]
    ])('returns the atomic reservation result %j', async (reservation) => {
      const fetchMock = vi.fn(async () => jsonResponse([reservation]));
      vi.stubGlobal('fetch', fetchMock);

      const result = await service.incrementAiParses('user-1');

      expect(result).toEqual(reservation);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`${URL}/rest/v1/rpc/reserve_ai_parse`);
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body as string)).toEqual({ p_user_id: 'user-1' });
    });

    it('fails closed when the database rejects a reservation', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('RPC unavailable', { status: 503, statusText: 'Unavailable' }))
      );

      await expect(service.incrementAiParses('user-1')).rejects.toThrow('API Error: Unavailable');
    });

    it('fails closed when the reservation response is malformed', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])));
      await expect(service.incrementAiParses('user-1')).rejects.toThrow(
        'Invalid AI parse reservation response'
      );
    });
  });

  describe('incrementTransactions', () => {
    it('increments transaction count', async () => {
      const usage = makeUsage({ transactions_count: 10 });
      const patchBodies: string[] = [];

      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, options?: RequestInit) => {
          if (options?.method === 'PATCH') {
            patchBodies.push(options.body as string);
          }
          return jsonResponse([usage]);
        }),
      );

      await service.incrementTransactions('user-1');
      expect(patchBodies).toHaveLength(1);
      const body = JSON.parse(patchBodies[0]) as { transactions_count: number };
      expect(body.transactions_count).toBe(11);
    });
  });
});
