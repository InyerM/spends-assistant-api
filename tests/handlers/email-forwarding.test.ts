import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleEmailForwardingRoute,
  handleForwardedEmail
} from '../../src/handlers/email-forwarding';
import { createMockEnv } from '../__test-helpers__/factories';

const { routes, inbox, resolveUserId } = vi.hoisted(() => ({
  routes: {
    getForUser: vi.fn(),
    createForUser: vi.fn(),
    deleteForUser: vi.fn(),
    getByAddress: vi.fn(),
    recordConfirmation: vi.fn()
  },
  inbox: { createForwardedPending: vi.fn() },
  resolveUserId: vi.fn()
}));

vi.mock('../../src/services/supabase', () => ({
  createSupabaseServices: () => ({ forwardingRoutes: routes, shortcutInbox: inbox, apiKeys: {} })
}));
vi.mock('../../src/utils/auth', () => ({
  resolveUserId,
  unauthorizedResponse: () => new Response('Unauthorized', { status: 401 })
}));

const env = {
  ...createMockEnv(),
  EMAIL_FORWARDING_DOMAIN: 'mail.example.com',
  EMAIL_FORWARDING_READY: 'true'
};
const address = `capture+${'a'.repeat(64)}@mail.example.com`;

function email(raw: string, to = address, from = 'forwarding-noreply@google.com') {
  let rejected = false;
  return {
    from,
    to,
    headers: new Headers(),
    rawSize: new TextEncoder().encode(raw).byteLength,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(raw));
        controller.close();
      }
    }),
    setReject: vi.fn(() => {
      rejected = true;
    }),
    get rejected() {
      return rejected;
    }
  };
}

describe('email forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveUserId.mockResolvedValue('owner-id');
    routes.getByAddress.mockResolvedValue({ user_id: 'owner-id', address });
  });

  it('requires auth and returns the owner route without exposing another route', async () => {
    resolveUserId.mockResolvedValueOnce(null);
    const denied = await handleEmailForwardingRoute(
      new Request('https://api.test/email-forwarding-route'),
      env
    );
    expect(denied.status).toBe(401);
    expect(routes.getForUser).not.toHaveBeenCalled();

    routes.getForUser.mockResolvedValue({
      address,
      created_at: '2026-10-01T00:00:00Z',
      confirmation_received_at: null,
      verification_text: null
    });
    const response = await handleEmailForwardingRoute(
      new Request('https://api.test/email-forwarding-route'),
      env
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'active', address });
    expect(routes.getForUser).toHaveBeenCalledWith('owner-id');
  });

  it('does not offer an undeliverable address before routing is ready', async () => {
    routes.getForUser.mockResolvedValue(null);
    const disabled = { ...env, EMAIL_FORWARDING_READY: undefined };
    const status = await handleEmailForwardingRoute(
      new Request('https://api.test/email-forwarding-route'),
      disabled
    );
    expect(await status.json()).toEqual({ status: 'unavailable' });

    const create = await handleEmailForwardingRoute(
      new Request('https://api.test/email-forwarding-route', { method: 'POST' }),
      disabled
    );
    expect(create.status).toBe(503);
    expect(routes.createForUser).not.toHaveBeenCalled();
  });

  it('creates and revokes a route only for the authenticated owner', async () => {
    routes.createForUser.mockResolvedValue({
      address,
      created_at: '2026-10-01T00:00:00Z',
      confirmation_received_at: null,
      verification_text: null
    });
    const created = await handleEmailForwardingRoute(
      new Request('https://api.test/email-forwarding-route', { method: 'POST' }),
      env
    );
    expect(created.status).toBe(201);
    expect(routes.createForUser).toHaveBeenCalledWith('owner-id', 'mail.example.com');
    const removed = await handleEmailForwardingRoute(
      new Request('https://api.test/email-forwarding-route', { method: 'DELETE' }),
      env
    );
    expect(removed.status).toBe(204);
    expect(routes.deleteForUser).toHaveBeenCalledWith('owner-id');
  });

  it('rejects unknown recipients without looking up an email sender', async () => {
    routes.getByAddress.mockResolvedValue(null);
    const message = email('Subject: Notice\r\n\r\nBank notice', 'unknown@mail.example.com');
    await handleForwardedEmail(message, env);
    expect(message.rejected).toBe(true);
    expect(inbox.createForwardedPending).not.toHaveBeenCalled();
  });

  it('rejects the bare routing address and resolves the complete plus address', async () => {
    routes.getByAddress.mockResolvedValueOnce(null);
    const bare = email('Subject: Notice\r\n\r\nBank notice', 'capture@mail.example.com');
    await handleForwardedEmail(bare, env);
    expect(bare.rejected).toBe(true);

    const routed = email('Subject: Notice\r\n\r\nBank notice');
    await handleForwardedEmail(routed, env);
    expect(routed.rejected).toBe(false);
    expect(routes.getByAddress).toHaveBeenLastCalledWith(address);
  });

  it('stores a MIME decoded notice as pending evidence without posting a transaction', async () => {
    const message = email(
      'Message-ID: <bank-123@example.com>\r\nSubject: Purchase alert\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\nQ29tcHJhc3RlICQ1MCwwMDAgZW4gTWVyY2FtYXM=',
      address,
      'attacker@example.com'
    );
    await handleForwardedEmail(message, env);
    expect(message.rejected).toBe(false);
    expect(inbox.createForwardedPending).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner-id',
        source: 'forwarded_email',
        rawText: 'Purchase alert\n\nCompraste $50,000 en Mercamas'
      })
    );
    expect(inbox.createForwardedPending.mock.calls[0][0].externalId).toMatch(/^[a-f0-9]{64}$/u);
    expect(routes.recordConfirmation).not.toHaveBeenCalled();
  });

  it('records Gmail confirmation content for the owner without creating an inbox item', async () => {
    const message = email(
      'From: Gmail Team <forwarding-noreply@google.com>\r\nSubject: Gmail Forwarding Confirmation\r\nContent-Type: text/plain\r\n\r\nConfirmation code: 123456789'
    );
    await handleForwardedEmail(message, env);
    expect(routes.recordConfirmation).toHaveBeenCalledWith(
      'owner-id',
      address,
      'Confirmation code: 123456789'
    );
    expect(inbox.createForwardedPending).not.toHaveBeenCalled();
  });

  it('rejects oversized raw MIME before reading it', async () => {
    const message = email('x');
    Object.defineProperty(message, 'rawSize', { value: 600_000 });
    await handleForwardedEmail(message, env);
    expect(message.rejected).toBe(true);
    expect(inbox.createForwardedPending).not.toHaveBeenCalled();
  });

  it('accepts a bank notice with inline email assets under the MIME limit', async () => {
    const message = email(`Subject: Bank notice\r\n\r\nCompra confirmada${' '.repeat(100_000)}`);
    await handleForwardedEmail(message, env);
    expect(message.rejected).toBe(false);
    expect(inbox.createForwardedPending).toHaveBeenCalledOnce();
  });
});
