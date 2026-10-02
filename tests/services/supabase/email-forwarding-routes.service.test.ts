import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailForwardingRoutesService } from '../../../src/services/supabase/email-forwarding-routes.service';
import { ShortcutInboxService } from '../../../src/services/supabase/shortcut-inbox.service';

const route = {
  user_id: 'owner-id',
  address: `capture+${'a'.repeat(64)}@mail.example.com`,
  created_at: '2026-10-01T00:00:00Z',
  confirmation_received_at: null,
  verification_text: null
};

describe('email forwarding Supabase services', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('creates one random owner route and returns the existing route on retry', async () => {
    const requests: Array<{ url: string; options?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        requests.push({ url, options });
        if (options?.method === 'POST') return Response.json([route]);
        return Response.json([]);
      })
    );
    const service = new EmailForwardingRoutesService('https://db.test', 'service-key');
    expect(await service.createForUser('owner-id', 'mail.example.com')).toEqual(route);
    const insert = requests.find(({ options }) => options?.method === 'POST');
    expect(insert).toBeDefined();
    expect(JSON.parse(String(insert?.options?.body))).toMatchObject({ user_id: 'owner-id' });
    expect(JSON.parse(String(insert?.options?.body)).address).toMatch(
      /^capture\+[a-f0-9]{64}@mail\.example\.com$/u
    );
    expect(requests[0].url).toContain('user_id=eq.owner-id');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json([route]))
    );
    expect(await service.createForUser('owner-id', 'mail.example.com')).toEqual(route);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('looks up the full plus address without losing its token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json([route]))
    );
    const service = new EmailForwardingRoutesService('https://db.test', 'service-key');
    expect(await service.getByAddress(route.address)).toEqual(route);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain(
      `address=eq.capture%2B${'a'.repeat(64)}%40mail.example.com`
    );
  });

  it('accepts an exact duplicate email delivery without changing reviewed inbox state', async () => {
    const rows: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        if (options?.method === 'POST') {
          const row = JSON.parse(String(options.body)) as Record<string, unknown>;
          if (rows.length) return new Response('duplicate', { status: 409 });
          rows.push(row);
          return Response.json([row]);
        }
        expect(url).toContain('user_id=eq.owner-id');
        expect(url).toContain('external_id=eq.');
        return Response.json([{ ...rows[0], status: 'dismissed' }]);
      })
    );
    const service = new ShortcutInboxService('https://db.test', 'service-key');
    const input = {
      userId: 'owner-id',
      source: 'forwarded_email',
      externalId: 'a'.repeat(64),
      rawText: 'Purchase alert\n\nCompraste $50,000',
      receivedAt: '2026-10-01T00:00:00Z'
    };
    await service.createForwardedPending(input);
    await service.createForwardedPending({ ...input, receivedAt: '2026-10-02T00:00:00Z' });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
  });

  it('rejects a reused message identity with different content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options?: RequestInit) => {
        if (options?.method === 'POST') return new Response('duplicate', { status: 409 });
        return Response.json([
          {
            user_id: 'owner-id',
            source: 'forwarded_email',
            external_id: 'a'.repeat(64),
            idempotency_key: 'b'.repeat(64),
            raw_text: 'Different content'
          }
        ]);
      })
    );
    const service = new ShortcutInboxService('https://db.test', 'service-key');
    await expect(
      service.createForwardedPending({
        userId: 'owner-id',
        source: 'forwarded_email',
        externalId: 'a'.repeat(64),
        rawText: 'Purchase alert',
        receivedAt: '2026-10-01T00:00:00Z'
      })
    ).rejects.toThrow(/identity conflict/u);
  });
});
