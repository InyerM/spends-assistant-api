import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransactionsService } from '../../../src/services/supabase/transactions.service';
import { AccountsService } from '../../../src/services/supabase/accounts.service';
import { CacheService } from '../../../src/services/cache.service';
import {
  createMockTransaction,
  createMockTransactionInput,
} from '../../__test-helpers__/factories';

const URL = 'https://test.supabase.co';
const KEY = 'test-key';

describe('TransactionsService', () => {
  let service: TransactionsService;
  let accountsService: AccountsService;

  beforeEach(() => {
    service = new TransactionsService(URL, KEY);
    accountsService = new AccountsService(URL, KEY);
    vi.restoreAllMocks();
  });

  describe('createTransaction', () => {
    it('creates a transaction and returns it', async () => {
      const tx = createMockTransaction();
      const calls: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('/transactions') && !url.includes('?')) {
          return new Response(JSON.stringify([tx]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        // Balance queries
        return new Response(JSON.stringify([{ balance: 500000 }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }));

      const input = createMockTransactionInput({ type: 'expense' });
      const result = await service.createTransaction(input, accountsService);
      expect(result.id).toBe('tx-1');
    });

    it('subtracts balance for expense', async () => {
      const tx = createMockTransaction();
      const patchBodies: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
        if (options?.method === 'PATCH') {
          patchBodies.push(options.body as string);
        }
        if (url.includes('/transactions') && !url.includes('?')) {
          return new Response(JSON.stringify([tx]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify([{ balance: 1000000 }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }));

      const input = createMockTransactionInput({ type: 'expense', amount: 50000 });
      await service.createTransaction(input, accountsService);
      expect(patchBodies).toHaveLength(1);
      expect(JSON.parse(patchBodies[0])).toEqual({ balance: 950000 });
    });

    it('adds balance for income', async () => {
      const tx = createMockTransaction();
      const patchBodies: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
        if (options?.method === 'PATCH') {
          patchBodies.push(options.body as string);
        }
        if (url.includes('/transactions') && !url.includes('?')) {
          return new Response(JSON.stringify([tx]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify([{ balance: 1000000 }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }));

      const input = createMockTransactionInput({ type: 'income', amount: 50000 });
      await service.createTransaction(input, accountsService);
      expect(patchBodies).toHaveLength(1);
      expect(JSON.parse(patchBodies[0])).toEqual({ balance: 1050000 });
    });

    it('handles transfer with dual balance updates', async () => {
      const tx = createMockTransaction();
      const patchBodies: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
        if (options?.method === 'PATCH') {
          patchBodies.push(options.body as string);
        }
        if (url.includes('/transactions') && !url.includes('?')) {
          return new Response(JSON.stringify([tx]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify([{ balance: 1000000 }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }));

      const input = createMockTransactionInput({
        type: 'transfer',
        amount: 50000,
        transfer_to_account_id: 'acc-2',
      });
      await service.createTransaction(input, accountsService);
      expect(patchBodies).toHaveLength(2);
      expect(JSON.parse(patchBodies[0])).toEqual({ balance: 950000 }); // subtract from source
      expect(JSON.parse(patchBodies[1])).toEqual({ balance: 1050000 }); // add to dest
    });

    it('invalidates cache after creation', async () => {
      const tx = createMockTransaction();
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.includes('/transactions') && !url.includes('?')) {
          return new Response(JSON.stringify([tx]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify([{ balance: 1000000 }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }));

      const cache = { del: vi.fn() } as unknown as CacheService;
      const input = createMockTransactionInput({ type: 'expense' });
      await service.createTransaction(input, accountsService, cache);
      expect(cache.del).toHaveBeenCalledWith('balance:acc-1');
    });
  });

  describe('findExactDuplicate', () => {
    it('returns transaction when exact match found', async () => {
      const tx = createMockTransaction();
      vi.stubGlobal('fetch', vi.fn(async () => {
        return new Response(JSON.stringify([tx]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }));

      const result = await service.findExactDuplicate('Compraste $50,000', 'api');
      expect(result).toEqual(tx);
    });

    it('returns null when no exact match', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }));

      const result = await service.findExactDuplicate('unique text', 'api');
      expect(result).toBeNull();
    });
  });

  describe('findNearDuplicate', () => {
    it('returns transaction when near match found', async () => {
      const tx = createMockTransaction();
      vi.stubGlobal('fetch', vi.fn(async () => {
        return new Response(JSON.stringify([tx]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }));

      const result = await service.findNearDuplicate('2024-01-15', 50000, 'acc-1');
      expect(result).toEqual(tx);
    });

    it('returns null when no near match', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }));

      const result = await service.findNearDuplicate('2024-01-15', 99999, 'acc-1');
      expect(result).toBeNull();
    });
  });
});
