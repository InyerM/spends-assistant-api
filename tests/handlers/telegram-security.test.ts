import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockEnv } from '../__test-helpers__/factories';
import { handleTelegram, handleTelegramSetup } from '../../src/handlers/telegram';

const spies = vi.hoisted(() => ({
  bot: vi.fn(),
  update: vi.fn(),
  services: vi.fn(() => ({})),
  cache: vi.fn()
}));
vi.mock('telegraf', () => ({
  Telegraf: class {
    constructor() {
      spies.bot();
    }
    catch(): void {}
    command(): void {}
    on(): void {}
    handleUpdate = spies.update;
  }
}));
vi.mock('../../src/services/supabase', () => ({ createSupabaseServices: spies.services }));
vi.mock('../../src/services/cache.service', () => ({
  CacheService: class {
    constructor() {
      spies.cache();
    }
  }
}));

const secret = 'unit-webhook-secret-with-at-least-32-characters';
const configured = () => ({
  ...createMockEnv(),
  TELEGRAM_WEBHOOK_SECRET: secret,
  TELEGRAM_OWNER_CHAT_ID: '12345',
  TELEGRAM_OWNER_USER_ID: '12345',
  TELEGRAM_WEBHOOK_URL: 'https://worker.example/telegram'
});
const update = () => ({
  update_id: 1,
  message: {
    message_id: 2,
    date: 1_700_000_000,
    from: { id: 12345, is_bot: false, first_name: 'Test' },
    chat: { id: 12345, type: 'private' },
    text: '/start'
  }
});
function webhook(body: unknown = update(), headers: Record<string, string> = {}): Request {
  return new Request('https://worker.example/telegram', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
      ...headers
    },
    body: JSON.stringify(body)
  });
}
function untouched(): void {
  expect(spies.bot).not.toHaveBeenCalled();
  expect(spies.services).not.toHaveBeenCalled();
  expect(spies.cache).not.toHaveBeenCalled();
  expect(spies.update).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
}

describe('Telegram owner webhook boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    'TELEGRAM_WEBHOOK_SECRET',
    'TELEGRAM_OWNER_CHAT_ID',
    'TELEGRAM_OWNER_USER_ID',
    'DEFAULT_USER_ID'
  ] as const)('fails closed without %s before downstream work', async (key) => {
    const env = { ...configured(), [key]: '' };
    expect((await handleTelegram(webhook(), env)).status).toBe(503);
    untouched();
  });
  it.each(['', 'wrong-secret', `${secret}x`, secret.slice(1)])(
    'rejects an absent or wrong secret before JSON parsing',
    async (value) => {
      const request = new Request('https://worker.example/telegram', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': value },
        body: '{'
      });
      const json = vi.spyOn(request, 'json');
      expect((await handleTelegram(request, configured())).status).toBe(401);
      expect(json).not.toHaveBeenCalled();
      untouched();
    }
  );
  it('accepts only the configured private owner message', async () => {
    const body = update();
    expect((await handleTelegram(webhook(body), configured())).status).toBe(200);
    expect(spies.update).toHaveBeenCalledExactlyOnceWith(body);
    expect(spies.services).toHaveBeenCalledOnce();
  });
  it.each(['foreign-chat', 'foreign-sender', 'group', 'bot', 'missing-from'])(
    'rejects %s before bot or services construction',
    async (variant) => {
      const body: Record<string, unknown> = update();
      const message = body.message as Record<string, unknown>;
      if (variant === 'foreign-chat') message.chat = { id: 67890, type: 'private' };
      if (variant === 'foreign-sender') message.from = { id: 67890, is_bot: false };
      if (variant === 'group') message.chat = { id: 12345, type: 'group' };
      if (variant === 'bot') message.from = { id: 12345, is_bot: true };
      if (variant === 'missing-from') delete message.from;
      expect((await handleTelegram(webhook(body), configured())).status).toBe(403);
      untouched();
    }
  );
  it.each(['0012345', '+12345', '12345.0', '1.2345e4', ' 12345', 4_503_599_627_370_496])(
    'refuses noncanonical or unsafe caller identity %s',
    async (id) => {
      const body = update();
      Object.assign(body.message.from, { id });
      expect((await handleTelegram(webhook(body), configured())).status).toBe(403);
      untouched();
    }
  );
  it('refuses noncanonical configured IDs rather than coercing them', async () => {
    expect(
      (await handleTelegram(webhook(), { ...configured(), TELEGRAM_OWNER_CHAT_ID: '0012345' }))
        .status
    ).toBe(503);
    untouched();
  });
  it.each(['callback_query', 'edited_message', 'channel_post', 'business_message'])(
    'refuses unsupported %s updates including mixed envelopes',
    async (key) => {
      expect((await handleTelegram(webhook({ ...update(), [key]: {} }), configured())).status).toBe(
        400
      );
      untouched();
    }
  );
  it('rejects malformed JSON and unsupported content before downstream work', async () => {
    const request = webhook();
    expect(
      (await handleTelegram(webhook(update(), { 'Content-Type': 'text/plain' }), configured()))
        .status
    ).toBe(415);
    const malformed = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: '{'
    });
    expect((await handleTelegram(malformed, configured())).status).toBe(400);
    untouched();
  });
  it('bounds the actual streamed body even with a dishonest small Content-Length', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65_537));
      },
      cancel
    });
    const request = new Request('https://worker.example/telegram', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '1',
        'X-Telegram-Bot-Api-Secret-Token': secret
      },
      body,
      duplex: 'half'
    } as RequestInit);
    expect((await handleTelegram(request, configured())).status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    untouched();
  });
  it('does not pass non-text or oversized message text to Telegraf', async () => {
    const body = update();
    body.message.text = 'x'.repeat(4097);
    expect((await handleTelegram(webhook(body), configured())).status).toBe(400);
    delete (body.message as Partial<typeof body.message>).text;
    expect((await handleTelegram(webhook(body), configured())).status).toBe(400);
    untouched();
  });
});

describe('Telegram webhook registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());
  const setup = (token = 'interactive-jwt') =>
    new Request('https://attacker.example/setup-webhook', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: 'https://attacker.example/telegram' })
    });
  it('rejects delegated/static authentication and a different interactive owner', async () => {
    expect((await handleTelegramSetup(setup(configured().API_KEY), configured())).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ id: 'another-user' }));
    expect((await handleTelegramSetup(setup(), configured())).status).toBe(403);
    expect(fetch).toHaveBeenCalledOnce();
    expect(spies.services).not.toHaveBeenCalled();
  });
  it('registers server-canonical URL and message-only secret using POST JSON', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ id: configured().DEFAULT_USER_ID }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: true }));
    const response = await handleTelegramSetup(setup(), configured());
    expect(response.status).toBe(200);
    const [url, options] = vi.mocked(fetch).mock.calls[1];
    expect(String(url)).toMatch(/\/setWebhook$/);
    expect(String(url)).not.toContain('?');
    expect(options).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    expect(JSON.parse(options?.body as string)).toEqual({
      url: configured().TELEGRAM_WEBHOOK_URL,
      secret_token: secret,
      allowed_updates: ['message']
    });
    const result = await response.text();
    expect(result).not.toContain(secret);
    expect(result).not.toContain(configured().TELEGRAM_BOT_TOKEN);
    expect(result).not.toContain(configured().DEFAULT_USER_ID);
    expect(spies.services).not.toHaveBeenCalled();
  });
  it.each([
    '',
    'http://worker.example/telegram',
    'https://worker.example/other',
    'https://worker.example/telegram?secret=value'
  ])('refuses missing or noncanonical server webhook URL %s', async (url) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ id: configured().DEFAULT_USER_ID }));
    expect(
      (await handleTelegramSetup(setup(), { ...configured(), TELEGRAM_WEBHOOK_URL: url })).status
    ).toBe(503);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('sanitizes Telegram failure responses rather than reflecting secret-bearing diagnostics', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ id: configured().DEFAULT_USER_ID }))
      .mockResolvedValueOnce(Response.json({ ok: false, description: secret }));
    const response = await handleTelegramSetup(setup(), configured());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(secret);
  });
});
