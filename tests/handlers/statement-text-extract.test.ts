import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleStatementTextExtract } from '../../src/handlers/statement-text-extract';
import { createMockEnv } from '../__test-helpers__/factories';
import { AiConsentRequiredError } from '../../src/services/supabase/ai-consent.service';
const mocks = vi.hoisted(() => ({
  consent: vi.fn(),
  quota: vi.fn(),
  track: vi.fn(),
  extract: vi.fn()
}));
vi.mock('../../src/ai/statement-text', () => ({
  STATEMENT_TEXT_MODEL: 'openai/gpt-4.1-nano',
  extractStatementText: mocks.extract
}));
vi.mock('../../src/services/supabase', () => ({
  createSupabaseServices: () => ({
    apiKeys: {},
    aiConsent: { require: mocks.consent },
    usage: { incrementAiParses: mocks.quota },
    aiUsage: { track: mocks.track }
  })
}));
vi.mock('../../src/utils/auth', () => ({
  resolveUserId: async (request: Request) =>
    request.headers.has('Authorization') ? 'owner' : null,
  unauthorizedResponse: () => Response.json({}, { status: 401 })
}));
const request = (pages: unknown, authenticated = true) =>
  new Request('http://localhost/documents/extract-text', {
    method: 'POST',
    headers: authenticated ? { Authorization: 'Bearer valid' } : {},
    body: JSON.stringify({ pages })
  });
describe('statement text review endpoint', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.consent.mockResolvedValue(undefined);
    mocks.quota.mockResolvedValue({ allowed: true });
    mocks.track.mockImplementation((_meta, callback) => callback({ record: vi.fn() }));
    mocks.extract.mockResolvedValue({
      draft: { document_type: 'statement', observations: [] },
      model: 'openai/gpt-4.1-nano',
      usage: null
    });
  });
  it('requires authentication before reading or analyzing statements', async () => {
    expect(
      (await handleStatementTextExtract(request(['Bancolombia COP 42000'], false), createMockEnv()))
        .status
    ).toBe(401);
    expect(mocks.extract).not.toHaveBeenCalled();
  });
  it('requires text consent and consumes exactly one document action quota', async () => {
    expect(
      (await handleStatementTextExtract(request(['Bancolombia COP 42000']), createMockEnv())).status
    ).toBe(200);
    expect(mocks.consent).toHaveBeenCalledWith('owner', 'financial_text');
    expect(mocks.quota).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'extract_document' }),
      expect.any(Function)
    );
  });
  it('checks consent and quota before any model call', async () => {
    mocks.consent.mockRejectedValueOnce(new AiConsentRequiredError('financial_text'));
    expect(
      (await handleStatementTextExtract(request(['Bancolombia COP 42000']), createMockEnv())).status
    ).toBe(428);
    expect(mocks.quota).not.toHaveBeenCalled();
    mocks.quota.mockResolvedValueOnce({ allowed: false });
    expect(
      (await handleStatementTextExtract(request(['Bancolombia COP 42000']), createMockEnv())).status
    ).toBe(429);
    expect(mocks.extract).not.toHaveBeenCalled();
  });
  it('records a safe failure reason without statement text or credentials', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.extract.mockRejectedValueOnce(new Error('Ungrounded statement excerpt'));
    const response = await handleStatementTextExtract(
      request(['Synthetic Bank COP 42000']),
      createMockEnv()
    );
    expect(response.status).toBe(502);
    expect(log).toHaveBeenCalledWith('statement_text_extraction_failed', {
      reason: 'Ungrounded statement excerpt'
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('Synthetic Bank');
    log.mockRestore();
  });
  it('fails closed for excessive pages, text or empty pages without consuming quota', async () => {
    for (const pages of [
      [],
      Array(11).fill('Bancolombia COP 42000'),
      ['a'.repeat(20001)],
      ['short']
    ])
      expect((await handleStatementTextExtract(request(pages), createMockEnv())).status).toBe(400);
    expect(mocks.quota).not.toHaveBeenCalled();
  });
});
