import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleBalance } from '../../src/handlers/balance';
import { createMockEnv } from '../__test-helpers__/factories';

describe('handleBalance', () => {
  const env = createMockEnv();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 400 when account ID is missing', async () => {
    const request = new Request('http://localhost/balance/');
    const response = await handleBalance(request, env);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Account ID required');
  });

  it('returns balance for valid account', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify([{ balance: 500000 }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    const request = new Request('http://localhost/balance/acc-1');
    const response = await handleBalance(request, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.account_id).toBe('acc-1');
    expect(body.balance).toBe(500000);
    expect(body.formatted).toBeDefined();
  });

  it('returns balance with auth resolving user via legacy API key', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('user_api_keys')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([{ balance: 750000 }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const request = new Request('http://localhost/balance/acc-1', {
      headers: {
        Authorization: `Bearer ${env.API_KEY}`,
      },
    });
    const response = await handleBalance(request, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.balance).toBe(750000);
  });

  it('returns 500 on service error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('Internal error', { status: 500, statusText: 'Internal Server Error' }),
    ));

    const request = new Request('http://localhost/balance/acc-1');
    const response = await handleBalance(request, env);
    expect(response.status).toBe(500);
  });
});
