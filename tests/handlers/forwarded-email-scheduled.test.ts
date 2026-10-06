import { beforeEach, expect, it, vi } from 'vitest';
import {
  handleQueuedForwardedEmail,
  handleScheduledForwardedEmails
} from '../../src/handlers/forwarded-email-scheduled';
import { emailFingerprint } from '../../src/utils/email-mime';
import { createMockEnv } from '../__test-helpers__/factories';
const mocks = vi.hoisted(() => ({
  route: vi.fn(),
  inbox: vi.fn(),
  accounts: vi.fn(),
  categories: vi.fn(),
  post: vi.fn(),
  classify: vi.fn()
}));
vi.mock('../../src/services/supabase', () => ({
  createSupabaseServices: () => ({
    forwardingRoutes: { getByAddress: mocks.route },
    shortcutInbox: { getPendingForwarded: mocks.inbox },
    accounts: { getAccounts: mocks.accounts },
    categories: { getCategories: mocks.categories },
    forwardedEmailAutoPost: { post: mocks.post },
    aiUsage: {}
  })
}));
vi.mock('../../src/ai/forwarded-purchase-category', () => ({
  classifyForwardedPurchase: mocks.classify
}));
const now = new Date('2026-10-05T18:00:00Z');
const env = {
  ...createMockEnv(),
  EMAIL_AUTO_POST_READY: 'true',
  EMAIL_AUTO_POST_AFTER: '2026-10-05T17:00:00Z',
  CLOUDFLARE_EMAIL_ZONE_ID: 'zone',
  EMAIL_FORWARDING_DOMAIN: 'example.com',
  CLOUDFLARE_ANALYTICS_TOKEN: 'secret'
};
const event = {
  datetime: '2026-10-05T17:40:00Z',
  messageId: '<purchase@example.com>',
  from: 'notificaciones@lulobank.com',
  to: 'capture+test@example.com',
  subject: 'Compra realizada',
  dkim: 'pass',
  dmarc: 'pass',
  arc: 'pass',
  isSpam: 0,
  action: 'worker',
  status: 'dropped',
  sampleInterval: 1
};
const text =
  'From (unverified): notificaciones@lulobank.com\n\nCompra realizada\n\nRealizaste una compra en STORE por $188,165.52\nOrigen tarjeta de crédito •8456\nFecha 5 de octubre de 2026\nHora 12:24 p.m.';
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.route.mockResolvedValue({
    user_id: 'owner',
    address: event.to,
    confirmation_received_at: 'yes',
    user_confirmed_at: 'yes'
  });
  mocks.inbox.mockResolvedValue({
    id: 'inbox',
    user_id: 'owner',
    external_id: await emailFingerprint({
      messageId: event.messageId,
      sender: null,
      subject: '',
      text: '',
      date: ''
    }),
    status: 'pending',
    source: 'forwarded_email',
    received_at: event.datetime,
    raw_text: text
  });
  mocks.accounts.mockResolvedValue([
    {
      id: 'account',
      institution: 'Lulo',
      type: 'credit_card',
      last_four: '8456',
      currency: 'COP',
      is_active: true
    }
  ]);
  mocks.categories.mockResolvedValue([]);
  mocks.classify.mockResolvedValue('category');
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ data: { viewer: { zones: [{ emailRoutingAdaptive: [event] }] } } })
      )
  );
});
it('posts only after authenticated analytics correlation and owner-scoped lookup', async () => {
  await handleScheduledForwardedEmails(env, now);
  const fingerprint = await emailFingerprint({
    sender: null,
    subject: '',
    text: '',
    date: '',
    messageId: event.messageId
  });
  expect(mocks.inbox).toHaveBeenCalledWith(
    'owner',
    fingerprint,
    new Date(env.EMAIL_AUTO_POST_AFTER).toISOString()
  );
  expect(mocks.post).toHaveBeenCalledWith(
    expect.objectContaining({ userId: 'owner', inboxItemId: 'inbox', amount: '188165.52' })
  );
});
it.each([
  { dkim: 'fail' },
  { dmarc: 'none' },
  { arc: 'fail' },
  { isSpam: 1 },
  { action: 'forward' },
  { messageId: '' },
  { from: 'attacker@example.com' },
  { subject: 'Payment' },
  { datetime: '2026-10-05T16:59:00Z' },
  { datetime: '2026-10-05T17:59:00Z' },
  { datetime: '2026-10-05T17:19:00Z' },
  { sampleInterval: 2 },
  { status: 'forwarded' }
])('rejects unsafe analytics evidence %j', async (override) => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        data: { viewer: { zones: [{ emailRoutingAdaptive: [{ ...event, ...override }] }] } }
      })
    )
  );
  await handleScheduledForwardedEmails(env, now);
  expect(mocks.post).not.toHaveBeenCalled();
});
it.each([
  { received_at: '2026-10-05T17:00:00Z' },
  { raw_text: text.replace('Compra realizada', 'Pago realizado') },
  { raw_text: text.replace('notificaciones@lulobank.com', 'attacker@example.com') },
  { status: 'confirmed' },
  { user_id: 'other' }
])('rejects mismatched inbox evidence %j', async (override) => {
  mocks.inbox.mockResolvedValue({
    id: 'inbox',
    user_id: 'owner',
    source: 'forwarded_email',
    status: 'pending',
    received_at: event.datetime,
    raw_text: text,
    ...override
  });
  await handleScheduledForwardedEmails(env, now);
  expect(mocks.post).not.toHaveBeenCalled();
});
it('does nothing without an activation cutoff', async () => {
  await handleScheduledForwardedEmails({ ...env, EMAIL_AUTO_POST_AFTER: undefined }, now);
  expect(fetch).not.toHaveBeenCalled();
});
it('waits until a post-activation event can be ten minutes old', async () => {
  await handleScheduledForwardedEmails(env, new Date('2026-10-05T17:05:00Z'));
  expect(fetch).not.toHaveBeenCalled();
});
it('leaves unresolved routes and ambiguous accounts pending', async () => {
  mocks.accounts.mockResolvedValue([{ id: 'wrong' }]);
  await handleScheduledForwardedEmails(env, now);
  expect(mocks.classify).not.toHaveBeenCalled();
});
it('accepts a single named MIME mailbox in analytics', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        data: {
          viewer: {
            zones: [
              {
                emailRoutingAdaptive: [
                  { ...event, from: 'Lulo Bank <notificaciones@lulobank.com>' }
                ]
              }
            ]
          }
        }
      })
    )
  );
  await handleScheduledForwardedEmails(env, now);
  expect(mocks.post).toHaveBeenCalledOnce();
});
it.each([
  {
    errors: [{ message: 'denied' }],
    data: { viewer: { zones: [{ emailRoutingAdaptive: [event] }] } }
  },
  {},
  { data: { viewer: { zones: [] } } }
])('fails closed on incomplete analytics %j', async (payload) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload)));
  await handleScheduledForwardedEmails(env, now);
  expect(mocks.post).not.toHaveBeenCalled();
});
it('requires exact route recipient equality', async () => {
  mocks.route.mockResolvedValue({
    user_id: 'owner',
    address: 'other@example.com',
    confirmation_received_at: 'yes',
    user_confirmed_at: 'yes'
  });
  await handleScheduledForwardedEmails(env, now);
  expect(mocks.inbox).not.toHaveBeenCalled();
});
it('limits uncertain classification to the bounded age window', async () => {
  mocks.classify.mockResolvedValue(null);
  for (const minute of [0, 15, 30, 45, 60]) {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ data: { viewer: { zones: [{ emailRoutingAdaptive: [event] }] } } })
        )
    );
    await handleScheduledForwardedEmails(
      env,
      new Date(Date.parse(event.datetime) + minute * 60_000)
    );
  }
  expect(mocks.classify).toHaveBeenCalledTimes(2);
  expect(mocks.post).not.toHaveBeenCalled();
});
it('does not post when GraphQL HTTP fails', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
  await handleScheduledForwardedEmails(env, now);
  expect(mocks.post).not.toHaveBeenCalled();
});
it.each(['confirmation_received_at', 'user_confirmed_at'])(
  'requires route verification %s',
  async (field) => {
    mocks.route.mockResolvedValue({
      user_id: 'owner',
      address: event.to,
      confirmation_received_at: 'yes',
      user_confirmed_at: 'yes',
      [field]: null
    });
    await handleScheduledForwardedEmails(env, now);
    expect(mocks.inbox).not.toHaveBeenCalled();
  }
);
it('queries only the eligible window with a fixed event cap', async () => {
  await handleScheduledForwardedEmails(env, now);
  const call = vi.mocked(fetch).mock.calls[0];
  const payload = JSON.parse((call[1] as RequestInit).body as string);
  expect(payload.variables.filter).toEqual({
    datetime_geq: '2026-10-05T17:20:00.000Z',
    datetime_leq: '2026-10-05T17:50:00.000Z'
  });
  expect(payload.query).toContain('limit: 100');
});

it('posts a targeted authenticated notice before the scheduled age threshold', async () => {
  const recent = { ...event, datetime: '2026-10-05T17:59:00Z' };
  mocks.inbox.mockResolvedValue({
    id: 'inbox',
    user_id: 'owner',
    external_id: await emailFingerprint({
      messageId: event.messageId,
      sender: null,
      subject: '',
      text: '',
      date: ''
    }),
    status: 'pending',
    source: 'forwarded_email',
    received_at: recent.datetime,
    raw_text: text
  });
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ data: { viewer: { zones: [{ emailRoutingAdaptive: [recent] }] } } })
      )
  );
  const result = await handleQueuedForwardedEmail(
    {
      externalId: await emailFingerprint({
        messageId: event.messageId,
        sender: null,
        subject: '',
        text: '',
        date: ''
      }),
      recipient: event.to,
      receivedAt: recent.datetime
    },
    env,
    now
  );
  expect(result).toBe('done');
  expect(mocks.post).toHaveBeenCalledOnce();
});

it('retries only when the correlated analytics event is unavailable', async () => {
  const externalId = await emailFingerprint({
    messageId: event.messageId,
    sender: null,
    subject: '',
    text: '',
    date: ''
  });
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ data: { viewer: { zones: [{ emailRoutingAdaptive: [] }] } } })
      )
  );
  expect(
    await handleQueuedForwardedEmail(
      { externalId, recipient: event.to, receivedAt: event.datetime },
      env,
      now
    )
  ).toBe('retry');
  expect(mocks.classify).not.toHaveBeenCalled();

  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        data: { viewer: { zones: [{ emailRoutingAdaptive: [{ ...event, dmarc: 'fail' }] }] } }
      })
    )
  );
  expect(
    await handleQueuedForwardedEmail(
      { externalId, recipient: event.to, receivedAt: event.datetime },
      env,
      now
    )
  ).toBe('done');
  expect(mocks.post).not.toHaveBeenCalled();
});
