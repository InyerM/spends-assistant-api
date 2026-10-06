import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleEmailForwardingRoute,
  handleForwardedEmail
} from '../../src/handlers/email-forwarding';
import { createMockEnv } from '../__test-helpers__/factories';

const { routes, inbox, aiUsage, completeJson, resolveUserId, accounts, categories, autoPost } =
  vi.hoisted(() => ({
    routes: {
      getForUser: vi.fn(),
      createForUser: vi.fn(),
      deleteForUser: vi.fn(),
      getByAddress: vi.fn(),
      recordConfirmation: vi.fn(),
      acknowledgeVerification: vi.fn()
    },
    inbox: { createForwardedPending: vi.fn() },
    accounts: { getAccounts: vi.fn() },
    categories: { getCategories: vi.fn() },
    autoPost: { post: vi.fn() },
    aiUsage: { track: vi.fn() },
    completeJson: vi.fn(),
    resolveUserId: vi.fn()
  }));

vi.mock('../../src/services/supabase', () => ({
  createSupabaseServices: () => ({
    forwardingRoutes: routes,
    shortcutInbox: inbox,
    accounts,
    categories,
    forwardedEmailAutoPost: autoPost,
    aiUsage,
    apiKeys: {}
  })
}));
vi.mock('../../src/ai/openrouter', () => ({ completeJson }));
vi.mock('../../src/utils/auth', () => ({
  resolveUserId,
  unauthorizedResponse: () => new Response('Unauthorized', { status: 401 })
}));

const env = {
  ...createMockEnv(),
  EMAIL_FORWARDING_DOMAIN: 'mail.example.com',
  EMAIL_FORWARDING_READY: 'true'
};
const address = `capture+${'a'.repeat(48)}@mail.example.com`;

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
    aiUsage.track.mockImplementation(async (_params, task) => task({ record: vi.fn() }));
    completeJson.mockResolvedValue({ data: { kind: 'uncertain', confidence: 0.5 } });
    routes.getByAddress.mockResolvedValue({
      user_id: 'owner-id',
      address,
      user_confirmed_at: null
    });
  });

  it('keeps eligible purchases pending until scheduled authentication', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T18:00:00Z'));
    try {
      routes.getByAddress.mockResolvedValue({
        user_id: 'owner-id',
        address,
        confirmation_received_at: '2026-10-03T16:45:00Z',
        user_confirmed_at: '2026-10-03T17:00:00Z'
      });
      inbox.createForwardedPending.mockResolvedValue({
        id: 'inbox-id',
        status: 'pending',
        created: true
      });
      accounts.getAccounts.mockResolvedValue([
        {
          id: 'account-id',
          institution: 'lulobank',
          type: 'credit_card',
          last_four: '8456',
          currency: 'COP',
          is_active: true
        }
      ]);
      categories.getCategories.mockResolvedValue([
        {
          id: 'category-id',
          slug: 'clothing',
          name: 'Clothing',
          type: 'expense',
          is_active: true
        }
      ]);
      completeJson.mockResolvedValue({ data: { category_slug: 'clothing', confidence: 0.98 } });
      autoPost.post.mockResolvedValue({ status: 'created', transaction_id: 'transaction-id' });
      const message = email(
        'From: Lulo Bank <notificaciones@lulobank.com>\r\nSubject: Compra realizada\r\nMessage-ID: <purchase-1@lulobank.com>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nRealizaste una compra en SHEIN.COM por $188,165.52\nOrigen tarjeta de crédito •8456\nFecha 5 de octubre de 2026\nHora 12:24 p.m.',
        address,
        'notificaciones@lulobank.com'
      );
      await handleForwardedEmail(message, { ...env, EMAIL_AUTO_POST_READY: 'true' });
      expect(autoPost.post).not.toHaveBeenCalled();
      expect(accounts.getAccounts).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('queues a new verified Lulo purchase for near-real-time authentication', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T02:00:00Z'));
    const send = vi.fn().mockResolvedValue(undefined);
    try {
      routes.getByAddress.mockResolvedValue({
        user_id: 'owner-id',
        address,
        confirmation_received_at: '2026-10-03T16:45:00Z',
        user_confirmed_at: '2026-10-03T17:00:00Z'
      });
      inbox.createForwardedPending.mockResolvedValue({
        id: 'inbox-id',
        status: 'pending',
        created: true
      });
      await handleForwardedEmail(
        email(
          'From: Lulo Bank <notificaciones@lulobank.com>\r\nSubject: Compra realizada\r\nMessage-ID: <purchase-1@lulobank.com>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nRealizaste una compra en STORE por $18,000\nOrigen tarjeta de crédito •8456\nFecha 5 de octubre de 2026\nHora 8:59 p.m.',
          address,
          'SRS0=example=notificaciones=lulobank.com@forwarder.example'
        ),
        {
          ...env,
          EMAIL_AUTO_POST_READY: 'true',
          EMAIL_AUTO_POST_AFTER: '2026-10-06T01:45:00Z',
          EMAIL_AUTH_QUEUE: { send } as unknown as Queue
        }
      );
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ recipient: address, receivedAt: '2026-10-06T02:00:00.000Z' }),
        { delaySeconds: 60 }
      );
      expect(autoPost.post).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not enqueue an already captured purchase again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T02:00:00Z'));
    const send = vi.fn();
    try {
      routes.getByAddress.mockResolvedValue({
        user_id: 'owner-id',
        address,
        confirmation_received_at: '2026-10-03T16:45:00Z',
        user_confirmed_at: '2026-10-03T17:00:00Z'
      });
      inbox.createForwardedPending.mockResolvedValue({
        id: 'inbox-id',
        status: 'pending',
        created: false
      });
      await handleForwardedEmail(
        email(
          'From: Lulo Bank <notificaciones@lulobank.com>\r\nSubject: Compra realizada\r\nMessage-ID: <purchase-1@lulobank.com>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nRealizaste una compra en STORE por $18,000\nOrigen tarjeta de crédito •8456\nFecha 5 de octubre de 2026\nHora 8:59 p.m.',
          address,
          'SRS0=example=notificaciones=lulobank.com@forwarder.example'
        ),
        {
          ...env,
          EMAIL_AUTO_POST_READY: 'true',
          EMAIL_AUTO_POST_AFTER: '2026-10-06T01:45:00Z',
          EMAIL_AUTH_QUEUE: { send } as unknown as Queue
        }
      );
      expect(send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a Lulo purchase pending when forwarding is unverified', async () => {
    inbox.createForwardedPending.mockResolvedValue({
      id: 'inbox-id',
      status: 'pending',
      created: true
    });
    await handleForwardedEmail(
      email(
        'From: Lulo Bank <notificaciones@lulobank.com>\r\nSubject: Compra realizada\r\n\r\nRealizaste una compra en SHEIN.COM por $188,165.52\nOrigen tarjeta de crédito •8456\nFecha 5 de octubre de 2026\nHora 12:24 p.m.',
        address,
        'notificaciones@lulobank.com'
      ),
      env
    );
    expect(autoPost.post).not.toHaveBeenCalled();
  });

  it('keeps automatic posting disabled until explicitly enabled', async () => {
    routes.getByAddress.mockResolvedValue({
      user_id: 'owner-id',
      address,
      confirmation_received_at: '2026-10-03T16:45:00Z',
      user_confirmed_at: '2026-10-03T17:00:00Z'
    });
    inbox.createForwardedPending.mockResolvedValue({
      id: 'inbox-id',
      status: 'pending',
      created: true
    });
    await handleForwardedEmail(
      email(
        'From: Lulo Bank <notificaciones@lulobank.com>\r\nSubject: Compra realizada\r\n\r\nRealizaste una compra en SHEIN.COM por $188,165.52\nOrigen tarjeta de crédito •8456\nFecha 5 de octubre de 2026\nHora 12:24 p.m.',
        address,
        'notificaciones@lulobank.com'
      ),
      env
    );
    expect(accounts.getAccounts).not.toHaveBeenCalled();
    expect(autoPost.post).not.toHaveBeenCalled();
  });

  it('keeps a rewritten forwarding envelope pending even when auto posting is enabled', async () => {
    routes.getByAddress.mockResolvedValue({
      user_id: 'owner-id',
      address,
      confirmation_received_at: '2026-10-03T16:45:00Z',
      user_confirmed_at: '2026-10-03T17:00:00Z'
    });
    inbox.createForwardedPending.mockResolvedValue({
      id: 'inbox-id',
      status: 'pending',
      created: true
    });
    await handleForwardedEmail(
      email(
        'From: Lulo Bank <notificaciones@lulobank.com>\r\nSubject: Compra realizada\r\n\r\nRealizaste una compra en SHEIN.COM por $188,165.52\nOrigen tarjeta de crédito •8456\nFecha 5 de octubre de 2026\nHora 12:24 p.m.',
        address,
        'SRS0=example=notificaciones=lulobank.com@forwarder.example'
      ),
      { ...env, EMAIL_AUTO_POST_READY: 'true' }
    );
    expect(autoPost.post).not.toHaveBeenCalled();
    expect(inbox.createForwardedPending).toHaveBeenCalledWith(
      expect.objectContaining({
        triageStatus: 'pending'
      })
    );
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

  it('lets the owner acknowledge a received Gmail confirmation but not a missing one', async () => {
    routes.acknowledgeVerification.mockResolvedValueOnce(null);
    const missing = await handleEmailForwardingRoute(
      new Request('https://api.test/email-forwarding-route', { method: 'PATCH' }),
      env
    );
    expect(missing.status).toBe(409);
    expect(routes.acknowledgeVerification).toHaveBeenCalledWith('owner-id');

    routes.acknowledgeVerification.mockResolvedValueOnce({
      address,
      created_at: '2026-10-01T00:00:00Z',
      confirmation_received_at: '2026-10-03T16:45:00Z',
      verification_text: 'Confirmation message',
      user_confirmed_at: '2026-10-03T17:00:00Z'
    });
    const confirmed = await handleEmailForwardingRoute(
      new Request('https://api.test/email-forwarding-route', { method: 'PATCH' }),
      env
    );
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({
      status: 'active',
      user_confirmed_at: '2026-10-03T17:00:00Z'
    });
    expect(routes.acknowledgeVerification).toHaveBeenCalledWith('owner-id');
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

  it('shows a previously unseen sender and auto-classifies an obvious promotion', async () => {
    const message = email(
      'From: Bancolombia Ofertas <new-alert@bancolombia.example>\r\nSubject: Aprovecha esta oferta especial\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nConoce nuestros descuentos de este mes.',
      address,
      'new-alert@bancolombia.example'
    );
    await handleForwardedEmail(message, env);
    expect(inbox.createForwardedPending).toHaveBeenCalledWith(
      expect.objectContaining({
        triageStatus: 'non_transaction',
        rawText: expect.stringContaining('new-alert@bancolombia.example')
      })
    );
    expect(completeJson).not.toHaveBeenCalled();
  });

  it('omits security codes from storage and never sends them to a model', async () => {
    const message = email(
      'From: Bancolombia <security@bancolombia.example>\r\nSubject: Tu código de seguridad\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nTu código de seguridad es 123456.',
      address,
      'security@bancolombia.example'
    );
    await handleForwardedEmail(message, env);
    const input = inbox.createForwardedPending.mock.calls[0][0];
    expect(input.triageStatus).toBe('non_transaction');
    expect(input.rawText).toContain('security@bancolombia.example');
    expect(input.rawText).toContain('[security_notice]');
    expect(input.rawText).not.toContain('123456');
    expect(completeJson).not.toHaveBeenCalled();
  });

  it('treats a generic one-time code as sensitive before AI triage', async () => {
    const message = email(
      'From: Bancolombia <new@bancolombia.example>\r\nSubject: Código\r\n\r\nTu código es 481927.',
      address,
      'new@bancolombia.example'
    );
    await handleForwardedEmail(message, env);
    expect(inbox.createForwardedPending.mock.calls[0][0].rawText).not.toContain('481927');
    expect(completeJson).not.toHaveBeenCalled();
  });

  it('omits an English verification code before saving or calling AI', async () => {
    await handleForwardedEmail(
      email('Subject: Your verification code\r\n\r\nUse 472916 to sign in.'),
      env
    );
    expect(inbox.createForwardedPending.mock.calls[0][0].rawText).toContain('[security_notice]');
    expect(inbox.createForwardedPending.mock.calls[0][0].rawText).not.toContain('472916');
    expect(completeJson).not.toHaveBeenCalled();
  });

  it('keeps a purchase with a security footer pending while removing its code', async () => {
    const message = email(
      'Subject: Compra realizada\r\n\r\nCompraste $50.000 en Mercamas. Tu código de seguridad es 481927.'
    );
    await handleForwardedEmail(message, env);
    const input = inbox.createForwardedPending.mock.calls[0][0];
    expect(input.triageStatus).toBe('pending');
    expect(input.rawText).toContain('Mercamas');
    expect(input.rawText).not.toContain('481927');
    expect(completeJson).not.toHaveBeenCalled();
  });

  it('keeps an amount-bearing debit pending when its body also mentions a code', async () => {
    await handleForwardedEmail(
      email('Subject: Débito automático\r\n\r\nCargo COP 120000. Tu código es 481927.'),
      env
    );
    const input = inbox.createForwardedPending.mock.calls[0][0];
    expect(input.triageStatus).toBe('pending');
    expect(input.rawText).not.toContain('481927');
  });

  it('recognizes a peso amount without a currency symbol before filtering security footers', async () => {
    await handleForwardedEmail(
      email('Subject: Pago realizado\r\n\r\nPagaste 50.000 pesos. Tu código es 481927.'),
      env
    );
    const input = inbox.createForwardedPending.mock.calls[0][0];
    expect(input.triageStatus).toBe('pending');
    expect(input.rawText).not.toContain('481927');
  });

  it('uses metered AI only for unclear mail and auto-classifies high-confidence non-transactions', async () => {
    completeJson.mockResolvedValueOnce({ data: { kind: 'promotion', confidence: 0.98 } });
    const message = email(
      'From: Novedades <new-bank@bancolombia.example>\r\nSubject: Noticias para ti\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nTenemos novedades para nuestros clientes.',
      address,
      'new-bank@bancolombia.example'
    );
    await handleForwardedEmail(message, env);
    expect(aiUsage.track).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner-id', operation: 'triage_forwarded_email' }),
      expect.any(Function)
    );
    expect(inbox.createForwardedPending).toHaveBeenCalledWith(
      expect.objectContaining({ triageStatus: 'non_transaction' })
    );
  });

  it('keeps low-confidence AI non-transaction labels pending for review', async () => {
    completeJson.mockResolvedValueOnce({ data: { kind: 'promotion', confidence: 0.8 } });
    await handleForwardedEmail(email('Subject: Novedades\r\n\r\nUn mensaje para ti.'), env);
    expect(inbox.createForwardedPending).toHaveBeenCalledWith(
      expect.objectContaining({ triageStatus: 'pending' })
    );
  });

  it('keeps an email with a monetary amount pending despite a non-transaction model label', async () => {
    completeJson.mockResolvedValueOnce({ data: { kind: 'other', confidence: 0.99 } });
    await handleForwardedEmail(
      email('Subject: Débito automático\r\n\r\nCargo COP 120000 en tu cuenta.'),
      env
    );
    expect(inbox.createForwardedPending).toHaveBeenCalledWith(
      expect.objectContaining({ triageStatus: 'pending' })
    );
  });

  it('redacts long numeric sequences from ambiguous mail before AI classification', async () => {
    await handleForwardedEmail(
      email('Subject: Aviso\r\n\r\nReferencia 481927 para tu consulta.'),
      env
    );
    expect(completeJson).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.not.stringContaining('481927') })
    );
    expect(inbox.createForwardedPending.mock.calls[0][0].rawText).not.toContain('481927');
  });

  it('keeps uncertain mail pending when the classifier fails', async () => {
    completeJson.mockRejectedValueOnce(new Error('Unavailable'));
    const message = email('Subject: Aviso Bancolombia\r\n\r\nRevisa tu cuenta.', address);
    await handleForwardedEmail(message, env);
    expect(message.rejected).toBe(false);
    expect(inbox.createForwardedPending).toHaveBeenCalledWith(
      expect.objectContaining({ triageStatus: 'pending' })
    );
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

  it('recognizes a Spanish Gmail forwarding confirmation', async () => {
    const message = email(
      'From: Gmail Team <forwarding-noreply@google.com>\r\nSubject: (Gmail Confirmaci\u00f3n de reenv\u00edo - Recibir correos de owner@example.com)\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nConfirma la solicitud en https://mail-settings.google.com/mail/verify-example'
    );
    await handleForwardedEmail(message, env);
    expect(routes.recordConfirmation).toHaveBeenCalledWith(
      'owner-id',
      address,
      expect.stringContaining('https://mail-settings.google.com/mail/verify-example')
    );
    expect(inbox.createForwardedPending).not.toHaveBeenCalled();
  });

  it('does not treat a forged Spanish confirmation as trusted Gmail mail', async () => {
    const message = email(
      'Subject: Gmail Confirmaci\u00f3n de reenv\u00edo\r\n\r\nFake verification',
      address,
      'attacker@example.com'
    );
    await handleForwardedEmail(message, env);
    expect(routes.recordConfirmation).not.toHaveBeenCalled();
    expect(inbox.createForwardedPending).toHaveBeenCalledOnce();
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
