import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UsageService } from '../../../src/services/supabase/usage.service';

const URL = 'https://test.supabase.co';
const KEY = 'test-service-key';

describe('UsageService', () => {
  let service: UsageService;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new UsageService(URL, KEY);
  });

  describe('getOrCreateMonthlyUsage', () => {
    it('returns existing usage record when found', async () => {
      const existing = {
        id: 'usage-1',
        user_id: 'user-1',
        month: new Date().toISOString().slice(0, 7),
        ai_parses_used: 5,
        ai_parses_limit: 15,
        transactions_count: 10,
        transactions_limit: 50,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      };

      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify([existing]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );

      const result = await service.getOrCreateMonthlyUsage('user-1');
      expect(result).toEqual(existing);
      expect(result.ai_parses_used).toBe(5);
    });

    it('creates new record when none exists', async () => {
      const created = {
        id: 'usage-new',
        user_id: 'user-1',
        month: new Date().toISOString().slice(0, 7),
        ai_parses_used: 0,
        ai_parses_limit: 15,
        transactions_count: 0,
        transactions_limit: 50,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      };

      let callCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            // GET returns empty
            return new Response(JSON.stringify([]), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          // POST returns created
          return new Response(JSON.stringify([created]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }),
      );

      const result = await service.getOrCreateMonthlyUsage('user-1');
      expect(result.ai_parses_used).toBe(0);
      expect(result.ai_parses_limit).toBe(15);
      expect(callCount).toBe(2);
    });
  });

  describe('incrementAiParses', () => {
    it('allows increment when under limit', async () => {
      const usage = {
        id: 'usage-1',
        user_id: 'user-1',
        month: new Date().toISOString().slice(0, 7),
        ai_parses_used: 5,
        ai_parses_limit: 15,
        transactions_count: 0,
        transactions_limit: 50,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      };

      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify([usage]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );

      const result = await service.incrementAiParses('user-1');
      expect(result.allowed).toBe(true);
      expect(result.used).toBe(6);
      expect(result.limit).toBe(15);
    });

    it('denies increment when at limit', async () => {
      const usage = {
        id: 'usage-1',
        user_id: 'user-1',
        month: new Date().toISOString().slice(0, 7),
        ai_parses_used: 15,
        ai_parses_limit: 15,
        transactions_count: 0,
        transactions_limit: 50,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      };

      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify([usage]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );

      const result = await service.incrementAiParses('user-1');
      expect(result.allowed).toBe(false);
      expect(result.used).toBe(15);
      expect(result.limit).toBe(15);
    });

    it('denies increment when over limit', async () => {
      const usage = {
        id: 'usage-1',
        user_id: 'user-1',
        month: new Date().toISOString().slice(0, 7),
        ai_parses_used: 20,
        ai_parses_limit: 15,
        transactions_count: 0,
        transactions_limit: 50,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      };

      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify([usage]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );

      const result = await service.incrementAiParses('user-1');
      expect(result.allowed).toBe(false);
      expect(result.used).toBe(20);
    });
  });

  describe('incrementTransactions', () => {
    it('increments transaction count', async () => {
      const usage = {
        id: 'usage-1',
        user_id: 'user-1',
        month: new Date().toISOString().slice(0, 7),
        ai_parses_used: 0,
        ai_parses_limit: 15,
        transactions_count: 10,
        transactions_limit: 50,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      };

      const patchBodies: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, options?: RequestInit) => {
          if (options?.method === 'PATCH') {
            patchBodies.push(options.body as string);
          }
          return new Response(JSON.stringify([usage]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }),
      );

      await service.incrementTransactions('user-1');
      expect(patchBodies).toHaveLength(1);
      const body = JSON.parse(patchBodies[0]) as { transactions_count: number };
      expect(body.transactions_count).toBe(11);
    });
  });
});
