import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleFinancialChat } from '../../src/handlers/financial-chat';
import { createMockEnv } from '../__test-helpers__/factories';

describe('read-only financial chat', () => {
  beforeEach(() => vi.restoreAllMocks());
  const env = createMockEnv();
  const request = (body: unknown, auth = true) =>
    new Request('http://localhost/financial/chat', {
      method: 'POST',
      headers: auth ? { Authorization: `Bearer ${env.API_KEY}` } : {},
      body: JSON.stringify(body)
    });
  function mock(
    options: { consent?: boolean; quota?: boolean; citations?: string[]; documents?: boolean } = {}
  ) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('ai_consent_decisions'))
        return Response.json(
          options.consent === false
            ? []
            : [
                {
                  scope: 'financial_text',
                  version: 'external-ai-v1',
                  granted_at: '2026-10-08',
                  revoked_at: null
                }
              ]
        );
      if (url.includes('reserve_ai_parse'))
        return Response.json([{ allowed: options.quota !== false, used: 1, limit: 15 }]);
      if (url.includes('/transactions?'))
        return Response.json([
          {
            id: 'tx-one',
            date: '2026-10-01',
            amount: 42,
            type: 'expense',
            account_id: 'account-one',
            currency: 'COP',
            description: 'Lunch'
          }
        ]);
      if (url.includes('/accounts?'))
        return Response.json([{ id: 'account-one', name: 'Cash', currency: 'COP', balance: 100 }]);
      if (url.includes('/documents?'))
        return Response.json(
          options.documents
            ? [{ id: 'doc-one', status: 'extracted', document_type: 'receipt' }]
            : []
        );
      if (url.includes('openrouter.ai'))
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  answer: 'Your recorded purchase is shown in the sources.',
                  citations: options.citations ?? ['transaction:tx-one']
                })
              }
            }
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0.00001 }
        });
      void init;
      return Response.json([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const body = { question: 'What did I spend?', month: '2026-10', corpusAcknowledged: true };
  it('requires auth and corpus acknowledgement before reading financial records', async () => {
    const fetchMock = mock();
    expect((await handleFinancialChat(request(body, false), env)).status).toBe(401);
    expect(
      (await handleFinancialChat(request({ ...body, corpusAcknowledged: false }), env)).status
    ).toBe(428);
    expect(fetchMock.mock.calls.some(([url]) => url.includes('/transactions?'))).toBe(false);
  });
  it('requires financial text consent before corpus retrieval', async () => {
    const fetchMock = mock({ consent: false });
    expect((await handleFinancialChat(request(body), env)).status).toBe(428);
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url.includes('/transactions?') || url.includes('openrouter.ai')
      )
    ).toBe(false);
  });
  it('enforces quota before financial retrieval and model calls', async () => {
    const fetchMock = mock({ quota: false });
    expect((await handleFinancialChat(request(body), env)).status).toBe(429);
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url.includes('/transactions?') || url.includes('openrouter.ai')
      )
    ).toBe(false);
  });
  it('bounds input and rejects impossible months', async () => {
    mock();
    for (const patch of [{ question: 'x'.repeat(2001) }, { month: '2026-13' }, { question: 123 }]) {
      expect((await handleFinancialChat(request({ ...body, ...patch }), env)).status).toBe(400);
    }
  });
  it('returns grounded sources with private cheap-model routing and scoped bounded reads', async () => {
    const fetchMock = mock();
    const response = await handleFinancialChat(request(body), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      citations: [{ id: 'transaction:tx-one', href: '/transactions/tx-one' }],
      coverage: { month: '2026-10', currencyBasis: 'Original currency; no FX conversion' }
    });
    const reads = fetchMock.mock.calls.filter(([url]) =>
      /\/(transactions|accounts|documents)\?/.test(url)
    );
    expect(reads).toHaveLength(3);
    for (const [url, init] of reads) {
      expect(decodeURIComponent(url)).toContain(`user_id=eq.${env.DEFAULT_USER_ID}`);
      expect(url).toContain('limit=');
      expect(url).not.toContain('raw_text');
      expect(init?.method ?? 'GET').toBe('GET');
    }
    const modelCall = fetchMock.mock.calls.find(([url]) => url.includes('openrouter.ai'))!;
    expect(JSON.parse(String(modelCall[1]?.body))).toMatchObject({
      model: 'openai/gpt-4.1-nano',
      provider: { zdr: true, data_collection: 'deny' }
    });
    const event = fetchMock.mock.calls.find(([url]) => url.includes('ai_usage_events'))!;
    expect(JSON.parse(String(event[1]?.body))).toMatchObject({ operation: 'financial_chat' });
    expect(String(event[1]?.body)).not.toContain('Lunch');
  });
  it('links document citations to the actual document list anchor', async () => {
    mock({ documents: true, citations: ['document:doc-one'] });
    const response = await handleFinancialChat(request(body), env);
    expect(await response.json()).toMatchObject({
      citations: [{ href: '/documents#document-doc-one' }]
    });
  });

  it('rejects citations outside the owner snapshot', async () => {
    mock({ citations: ['transaction:other-owner'] });
    expect((await handleFinancialChat(request(body), env)).status).toBe(502);
  });
});
