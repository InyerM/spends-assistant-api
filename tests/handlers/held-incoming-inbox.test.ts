import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleTransaction } from '../../src/handlers/transaction';
import { createMockEnv } from '../__test-helpers__/factories';

vi.mock('../../src/parsers/expense', () => ({ parseExpense: vi.fn() }));
vi.mock('../../src/services/cache.service', () => ({ CacheService: class {} }));

const env = createMockEnv();
const notice =
  'Bancolombia: Recibiste una transferencia por $50.000 a tu cuenta, el 14:30 a las 15/09/2026';

function request(text: string, extras: Record<string, unknown> = {}): Request {
  return new Request('http://localhost/transaction', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.API_KEY}`
    },
    body: JSON.stringify({ text, source: 'sms-bulk', ...extras })
  });
}

function stubDatabase() {
  const inbox: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  const transactions: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/rest/v1/shortcut_inbox_items')) {
        if (init?.method === 'POST') {
          const row = JSON.parse(String(init.body)) as Record<string, unknown>;
          if (inbox.some((item) => item.idempotency_key === row.idempotency_key)) {
            return Response.json({ code: '23505' }, { status: 409 });
          }
          inbox.push({ id: 'inbox-1', status: 'pending', ...row });
          return Response.json([inbox.at(-1)]);
        }
        const key = new URL(url).searchParams.get('idempotency_key')?.slice(3);
        return Response.json(inbox.filter((row) => row.idempotency_key === key));
      }
      if (url.includes('/rest/v1/skipped_messages')) {
        skipped.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json([{ id: `skipped-${skipped.length}` }]);
      }
      if (url.includes('/rest/v1/transactions') && init?.method === 'POST') {
        transactions.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      return Response.json([]);
    })
  );
  return { inbox, skipped, transactions };
}

describe('held incoming notices in the legacy transaction route', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    const { parseExpense } = await import('../../src/parsers/expense');
    vi.mocked(parseExpense).mockResolvedValue({
      is_transaction: false,
      skip_reason: 'incoming_transfer_requires_review',
      amount: 0,
      description: '',
      category: 'missing',
      bank: 'bancolombia',
      payment_type: 'unknown',
      source: 'manual',
      confidence: 100
    });
  });

  it('keeps the legacy skipped response and queues an owner-scoped immutable notice with explicit receipt time', async () => {
    const db = stubDatabase();
    const first = await handleTransaction(
      request(notice, { received_at: '2026-09-15T14:31:00-05:00', user_id: 'foreign-user' }),
      env
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      status: 'skipped',
      reason: 'incoming_transfer_requires_review'
    });
    expect(db.inbox).toMatchObject([
      {
        user_id: env.DEFAULT_USER_ID,
        source: 'sms-bulk',
        received_at: '2026-09-15T19:31:00.000Z',
        raw_text: notice,
        status: 'pending'
      }
    ]);
    expect(db.inbox[0].idempotency_key).toMatch(/^[a-f0-9]{64}$/);
    expect(db.skipped).toHaveLength(1);
    expect(db.transactions).toHaveLength(0);

    const replay = await handleTransaction(
      request(notice, { received_at: '2026-09-15T19:31:00Z' }),
      env
    );
    expect(replay.status).toBe(200);
    expect(db.inbox).toHaveLength(1);
    expect(db.transactions).toHaveLength(0);
  });

  it('uses a valid Shortcut receipt prefix without replacing the original text', async () => {
    const db = stubDatabase();
    const prefixed = `[Recibido: 15/09/2026 14:31] ${notice}`;
    const response = await handleTransaction(request(prefixed), env);
    expect(response.status).toBe(200);
    expect(db.inbox).toMatchObject([
      { received_at: '2026-09-15T19:31:00.000Z', raw_text: prefixed }
    ]);
  });

  it('does not invent an SMS receipt time from a bank event or the server clock', async () => {
    const db = stubDatabase();
    const response = await handleTransaction(request(notice), env);
    expect(response.status).toBe(200);
    expect(db.inbox).toHaveLength(0);
    expect(db.skipped).toHaveLength(1);
    expect(db.transactions).toHaveLength(0);
  });

  it('leaves a conflicting or impossible receipt timestamp out of the inbox', async () => {
    const db = stubDatabase();
    const prefixed = `[Recibido: 15/09/2026 14:31] ${notice}`;
    expect(
      (
        await handleTransaction(
          request(prefixed, { received_at: '2026-09-15T15:31:00-05:00' }),
          env
        )
      ).status
    ).toBe(200);
    expect(
      (await handleTransaction(request(`[Recibido: 31/02/2026 14:31] ${notice}`), env)).status
    ).toBe(200);
    expect(db.inbox).toHaveLength(0);
    expect(db.skipped).toHaveLength(2);
  });

  it('keeps ordinary skipped messages out of the financial review inbox', async () => {
    const { parseExpense } = await import('../../src/parsers/expense');
    vi.mocked(parseExpense).mockResolvedValueOnce({
      is_transaction: false,
      skip_reason: 'marketing',
      amount: 0,
      description: '',
      category: 'missing',
      bank: 'bancolombia',
      payment_type: 'unknown',
      source: 'manual',
      confidence: 100
    });
    const db = stubDatabase();
    const response = await handleTransaction(
      request('Synthetic promotion', { received_at: '2026-09-15T14:31:00-05:00' }),
      env
    );
    expect(response.status).toBe(200);
    expect(db.inbox).toHaveLength(0);
    expect(db.skipped).toHaveLength(1);
  });

  it('returns a retryable error if the pending inbox insert fails', async () => {
    const db = stubDatabase();
    const defaultFetch = vi.mocked(fetch);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (String(input).includes('/rest/v1/shortcut_inbox_items')) {
          return Response.json({ error: 'unavailable' }, { status: 503 });
        }
        return defaultFetch(input, init);
      })
    );
    const response = await handleTransaction(
      request(notice, { received_at: '2026-09-15T14:31:00-05:00' }),
      env
    );
    expect(response.status).toBe(500);
    expect(db.skipped).toHaveLength(1);
    expect(db.inbox).toHaveLength(0);
    expect(db.transactions).toHaveLength(0);
  });
});
