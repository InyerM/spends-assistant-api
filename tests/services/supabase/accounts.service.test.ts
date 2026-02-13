import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccountsService } from '../../../src/services/supabase/accounts.service';
import { createMockAccount, createMockFetch } from '../../__test-helpers__/factories';

const URL = 'https://test.supabase.co';
const KEY = 'test-key';

describe('AccountsService', () => {
  let service: AccountsService;

  beforeEach(() => {
    service = new AccountsService(URL, KEY);
    vi.restoreAllMocks();
  });

  describe('getAccount', () => {
    it('finds account with all params (institution + lastFour + type)', async () => {
      const account = createMockAccount();
      const mockFn = createMockFetch({ accounts: { data: [account] } });
      vi.stubGlobal('fetch', mockFn);

      const result = await service.getAccount('bancolombia', '2651', 'savings');
      expect(result).toEqual(account);
    });

    it('falls back to institution + lastFour when type search fails', async () => {
      const account = createMockAccount();
      let callCount = 0;
      vi.stubGlobal('fetch', vi.fn(async () => {
        callCount++;
        // First call (all params) returns empty, second call (inst+last4) returns account
        const data = callCount === 1 ? [] : [account];
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }));

      const result = await service.getAccount('bancolombia', '2651', 'checking');
      expect(result).toEqual(account);
    });

    it('falls back to institution + type when lastFour not provided', async () => {
      const account = createMockAccount();
      vi.stubGlobal('fetch', createMockFetch({ accounts: { data: [account] } }));

      const result = await service.getAccount('bancolombia', null, 'savings');
      expect(result).toEqual(account);
    });

    it('falls back to institution only', async () => {
      const account = createMockAccount();
      vi.stubGlobal('fetch', vi.fn(async () => {
        return new Response(JSON.stringify([account]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }));

      const result = await service.getAccount('bancolombia');
      expect(result).toEqual(account);
    });

    it('returns null when no account found', async () => {
      vi.stubGlobal('fetch', createMockFetch({ accounts: { data: [] } }));

      const result = await service.getAccount('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getAccountBalance', () => {
    it('returns balance for existing account', async () => {
      vi.stubGlobal(
        'fetch',
        createMockFetch({ accounts: { data: [{ balance: 500000 }] } }),
      );

      const result = await service.getAccountBalance('acc-1');
      expect(result).toBe(500000);
    });

    it('returns 0 when account not found', async () => {
      vi.stubGlobal('fetch', createMockFetch({ accounts: { data: [] } }));

      const result = await service.getAccountBalance('nonexistent');
      expect(result).toBe(0);
    });
  });

  describe('updateBalance', () => {
    it('adds to balance', async () => {
      const calls: { url: string; body: string }[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
        calls.push({ url, body: options?.body as string || '' });
        // First call: getAccountBalance returns 500000
        // Second call: PATCH
        const data = calls.length === 1 ? [{ balance: 500000 }] : {};
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }));

      await service.updateBalance('acc-1', 100000, 'add');
      const patchCall = calls[1];
      expect(JSON.parse(patchCall.body)).toEqual({ balance: 600000 });
    });

    it('subtracts from balance', async () => {
      const calls: { url: string; body: string }[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
        calls.push({ url, body: options?.body as string || '' });
        const data = calls.length === 1 ? [{ balance: 500000 }] : {};
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }));

      await service.updateBalance('acc-1', 100000, 'subtract');
      const patchCall = calls[1];
      expect(JSON.parse(patchCall.body)).toEqual({ balance: 400000 });
    });
  });
});
