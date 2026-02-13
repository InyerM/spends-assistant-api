import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../src/index';

// Mock all handlers
vi.mock('../src/handlers/telegram', () => ({
  handleTelegram: vi.fn(async () => new Response('telegram ok')),
}));
vi.mock('../src/handlers/email', () => ({
  handleEmail: vi.fn(async () => new Response('email ok')),
}));
vi.mock('../src/handlers/transaction', () => ({
  handleTransaction: vi.fn(async () => new Response('transaction ok')),
}));
vi.mock('../src/handlers/parse', () => ({
  handleParse: vi.fn(async () => new Response('parse ok')),
}));
vi.mock('../src/handlers/balance', () => ({
  handleBalance: vi.fn(async () => new Response('balance ok')),
}));

const env = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_KEY: 'test-key',
  GEMINI_API_KEY: 'test-key',
  TELEGRAM_BOT_TOKEN: 'test-token',
  API_KEY: 'test-api-key',
};

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
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

  it('returns webhook setup info on /setup-webhook', async () => {
    const request = new Request('http://localhost/setup-webhook', { method: 'GET' });
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.message).toContain('webhook');
    expect(body.url).toContain('api.telegram.org');
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
