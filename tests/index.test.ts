import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../src/index';

// Mock all handlers
vi.mock('../src/handlers/telegram', () => ({
  handleTelegram: vi.fn(async () => new Response('telegram ok')),
  handleTelegramSetup: vi.fn(async () => new Response('Unauthorized', { status: 401 }))
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
vi.mock('../src/handlers/merchant-suggest', () => ({
  handleMerchantSuggest: vi.fn(async () => new Response('merchant ok'))
}));
vi.mock('../src/handlers/ai-consent', () => ({
  handleAiConsent: vi.fn(async () => new Response('consent ok'))
}));
vi.mock('../src/handlers/balance', () => ({
  handleBalance: vi.fn(async () => new Response('balance ok'))
}));

const scheduledMocks = vi.hoisted(() => ({
  cleanup: vi.fn(),
  aiCleanup: vi.fn(),
  planning: vi.fn(),
  forward: vi.fn(),
  queued: vi.fn(),
  analyze: vi.fn(async () => new Response('analysis ok')),
  dispatchHandler: vi.fn(async () => new Response('dispatch ok')),
  dispatch: vi.fn(),
  analysisJob: vi.fn()
}));
vi.mock('../src/handlers/forwarded-email-scheduled', () => ({
  handleScheduledForwardedEmails: scheduledMocks.forward,
  handleQueuedForwardedEmail: scheduledMocks.queued
}));
vi.mock('../src/handlers/inbox-analysis', () => ({
  handleInboxAnalyze: scheduledMocks.analyze,
  handleInboxAnalysisDispatch: scheduledMocks.dispatchHandler
}));
vi.mock('../src/services/inbox-analysis', () => ({
  dispatchInboxAnalysis: scheduledMocks.dispatch,
  processInboxAnalysisJob: scheduledMocks.analysisJob
}));
vi.mock('../src/services/supabase', () => ({
  createSupabaseServices: () => ({
    planning: { processDueExpenses: scheduledMocks.planning },
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

  it.each(['GET', 'POST'])('routes /ai/consent %s to consent handling', async (method) => {
    const { handleAiConsent } = await import('../src/handlers/ai-consent');
    const request = new Request('http://localhost/ai/consent', { method });
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    expect(handleAiConsent).toHaveBeenCalledWith(request, env);
  });

  it('routes /vision/extract POST to handleVisionExtract', async () => {
    const { handleVisionExtract } = await import('../src/handlers/vision-extract');
    const request = new Request('http://localhost/vision/extract', { method: 'POST' });
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    expect(handleVisionExtract).toHaveBeenCalled();
  });

  it('routes /merchant/suggest POST to the owner-scoped suggestion handler', async () => {
    const { handleMerchantSuggest } = await import('../src/handlers/merchant-suggest');
    const request = new Request('http://localhost/merchant/suggest', { method: 'POST' });
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    expect(handleMerchantSuggest).toHaveBeenCalledWith(request, env);
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

it('routes only the fifteen-minute cron to email and opt-in recurring expense processing', async () => {
  vi.clearAllMocks();
  for (const cron of ['*/15 * * * *', 'unknown']) {
    await worker.scheduled({ cron, scheduledTime: 123 } as ScheduledEvent, env, ctx);
  }
  expect(scheduledMocks.planning).toHaveBeenCalledOnce();
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
  expect(scheduledMocks.planning).not.toHaveBeenCalled();
});

it('acknowledges completed email jobs and retries unavailable authentication evidence', async () => {
  const job = {
    externalId: 'a'.repeat(64),
    recipient: 'capture@example.com',
    receivedAt: '2026-10-05T18:00:00Z'
  };
  const done = { body: job, ack: vi.fn(), retry: vi.fn() };
  const pending = { body: job, ack: vi.fn(), retry: vi.fn() };
  scheduledMocks.queued.mockResolvedValueOnce('done').mockResolvedValueOnce('retry');
  await worker.queue({ messages: [done, pending] } as unknown as MessageBatch<unknown>, env, ctx);
  expect(done.ack).toHaveBeenCalledOnce();
  expect(done.retry).not.toHaveBeenCalled();
  expect(pending.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  expect(pending.ack).not.toHaveBeenCalled();
});

it('routes inbox analysis and arrival dispatch to authenticated handlers', async () => {
  const analyze = new Request('https://example.test/inbox/analyze', { method: 'POST' });
  const dispatch = new Request('https://example.test/inbox/analysis-dispatch', { method: 'POST' });
  await worker.fetch(analyze, env, ctx);
  await worker.fetch(dispatch, env, ctx);
  expect(scheduledMocks.analyze).toHaveBeenCalledWith(analyze, env);
  expect(scheduledMocks.dispatchHandler).toHaveBeenCalledWith(dispatch, env, ctx);
});
it('recovers durable inbox suggestions every minute without financial posting', async () => {
  vi.clearAllMocks();
  await worker.scheduled({ cron: '*/1 * * * *' } as ScheduledEvent, env, ctx);
  expect(scheduledMocks.dispatch).toHaveBeenCalledWith(env);
  expect(scheduledMocks.forward).not.toHaveBeenCalled();
  expect(scheduledMocks.planning).not.toHaveBeenCalled();
});
it('routes analysis jobs independently of legacy email posting and rejects malformed IDs', async () => {
  vi.clearAllMocks();
  const good = {
    body: { kind: 'inbox_analysis', inboxItemId: '11111111-1111-4111-8111-111111111111' },
    ack: vi.fn(),
    retry: vi.fn()
  };
  const bad = {
    body: { kind: 'inbox_analysis', inboxItemId: 'bad' },
    ack: vi.fn(),
    retry: vi.fn()
  };
  await worker.queue({ messages: [good, bad] } as unknown as MessageBatch<unknown>, env, ctx);
  expect(scheduledMocks.analysisJob).toHaveBeenCalledExactlyOnceWith(good.body, env);
  expect(scheduledMocks.queued).not.toHaveBeenCalled();
  expect(good.ack).toHaveBeenCalledOnce();
  expect(bad.ack).toHaveBeenCalledOnce();
});
