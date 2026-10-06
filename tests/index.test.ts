import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../src/index';

// Mock all handlers
vi.mock('../src/handlers/telegram', () => ({
  handleTelegram: vi.fn(async () => new Response('telegram ok'))
}));
vi.mock('../src/handlers/email', () => ({
  handleEmail: vi.fn(async () => new Response('email ok'))
}));
vi.mock('../src/handlers/transaction', () => ({
  handleTransaction: vi.fn(async () => new Response('transaction ok'))
}));
vi.mock('../src/handlers/parse', () => ({
  handleParse: vi.fn(async () => new Response('parse ok'))
}));
vi.mock('../src/handlers/vision-extract', () => ({
  handleVisionExtract: vi.fn(async () => new Response('vision ok'))
}));
vi.mock('../src/handlers/balance', () => ({
  handleBalance: vi.fn(async () => new Response('balance ok'))
}));

const scheduledMocks = vi.hoisted(() => ({
  cleanup: vi.fn(),
  aiCleanup: vi.fn(),
  forward: vi.fn()
}));
vi.mock('../src/handlers/forwarded-email-scheduled', () => ({
  handleScheduledForwardedEmails: scheduledMocks.forward
}));
vi.mock('../src/services/supabase', () => ({
  createSupabaseServices: () => ({
    usage: { cleanupOldRecords: scheduledMocks.cleanup },
    aiUsage: { cleanupOldEvents: scheduledMocks.aiCleanup }
  })
}));

const env = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_KEY: 'test-key',
  OPENROUTER_API_KEY: 'test-key',
  TELEGRAM_BOT_TOKEN: 'test-token',
  API_KEY: 'test-api-key'
};

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn()
} as unknown as ExecutionContext;

describe('Worker routing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns health check on /', async () => {
    const request = new Request('http://localhost/');
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('expense-assistant');
  });

  it('returns health check on /health', async () => {
    const request = new Request('http://localhost/health');
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
  });

  it('requires POST and authentication for webhook setup', async () => {
    const request = new Request('http://localhost/setup-webhook', { method: 'GET' });
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(404);
    const post = new Request('http://localhost/setup-webhook', { method: 'POST' });
    expect((await worker.fetch(post, env, ctx)).status).toBe(401);
  });

  it('routes /telegram POST to handleTelegram', async () => {
    const { handleTelegram } = await import('../src/handlers/telegram');
    const request = new Request('http://localhost/telegram', { method: 'POST' });
    await worker.fetch(request, env, ctx);
    expect(handleTelegram).toHaveBeenCalled();
  });

  it('routes /transaction POST to handleTransaction', async () => {
    const { handleTransaction } = await import('../src/handlers/transaction');
    const request = new Request('http://localhost/transaction', { method: 'POST' });
    await worker.fetch(request, env, ctx);
    expect(handleTransaction).toHaveBeenCalled();
  });

  it('routes /balance/:id GET to handleBalance', async () => {
    const { handleBalance } = await import('../src/handlers/balance');
    const request = new Request('http://localhost/balance/acc-1', { method: 'GET' });
    await worker.fetch(request, env, ctx);
    expect(handleBalance).toHaveBeenCalled();
  });

  it('routes /parse POST to handleParse', async () => {
    const { handleParse } = await import('../src/handlers/parse');
    const request = new Request('http://localhost/parse', { method: 'POST' });
    await worker.fetch(request, env, ctx);
    expect(handleParse).toHaveBeenCalled();
  });

  it('routes /vision/extract POST to handleVisionExtract', async () => {
    const { handleVisionExtract } = await import('../src/handlers/vision-extract');
    const request = new Request('http://localhost/vision/extract', { method: 'POST' });
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    expect(handleVisionExtract).toHaveBeenCalled();
  });

  it('routes /email POST to handleEmail', async () => {
    const { handleEmail } = await import('../src/handlers/email');
    const request = new Request('http://localhost/email', { method: 'POST' });
    await worker.fetch(request, env, ctx);
    expect(handleEmail).toHaveBeenCalled();
  });

  it('returns 404 for unknown routes', async () => {
    const request = new Request('http://localhost/unknown');
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(404);
  });
});

it('routes only the exact email cron to automatic posting', async () => {
  vi.clearAllMocks();
  for (const cron of ['*/15 * * * *', 'unknown']) {
    await worker.scheduled({ cron, scheduledTime: 123 } as ScheduledEvent, env, ctx);
  }
  expect(scheduledMocks.forward).toHaveBeenCalledOnce();
  expect(scheduledMocks.forward).toHaveBeenCalledWith(env, new Date(123));
  expect(scheduledMocks.cleanup).not.toHaveBeenCalled();
});
it('routes the monthly cron exclusively to cleanup', async () => {
  vi.clearAllMocks();
  await worker.scheduled({ cron: '0 3 1 * *', scheduledTime: 123 } as ScheduledEvent, env, ctx);
  expect(scheduledMocks.cleanup).toHaveBeenCalledOnce();
  expect(scheduledMocks.aiCleanup).toHaveBeenCalledOnce();
  expect(scheduledMocks.forward).not.toHaveBeenCalled();
});
