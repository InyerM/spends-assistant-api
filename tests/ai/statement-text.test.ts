import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiUsageMeter } from '../../src/ai/usage-meter';
import { extractStatementText, validateStatementChunk } from '../../src/ai/statement-text';
const source = 'Bancolombia COP\n2026-10-01 COMPRA CAFE -42.000,00';
const row = {
  amount: -42000,
  currency: 'COP',
  occurred_at: '2026-10-01',
  description: 'Cafe',
  counterparty: 'Cafe',
  reference: null,
  source_excerpt: '2026-10-01 COMPRA CAFE -42.000,00',
  confidence: 0.95
};
describe('grounded PDF statement drafts', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('requires original source excerpts and rejects fabricated amounts', () => {
    expect(
      validateStatementChunk({ observations: [row], complete: true }, source).observations
    ).toHaveLength(1);
    expect(() =>
      validateStatementChunk({ observations: [{ ...row, amount: 999 }], complete: true }, source)
    ).toThrow();
    expect(() =>
      validateStatementChunk(
        { observations: [{ ...row, source_excerpt: 'Fabricated' }], complete: true },
        source
      )
    ).toThrow();
  });
  it('fails the whole draft when the model truncates or declares incomplete coverage', () => {
    expect(() =>
      validateStatementChunk({ observations: [row], complete: false }, source)
    ).toThrow();
  });
  it('retries an ungrounded model excerpt once while retaining exact original evidence', async () => {
    const envelope = (observations: unknown[]) =>
      Response.json({
        choices: [
          {
            message: { content: JSON.stringify({ complete: true, observations }) },
            finish_reason: 'stop'
          }
        ]
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(envelope([{ ...row, source_excerpt: 'Rewritten row' }]))
      .mockResolvedValueOnce(envelope([row]));
    vi.stubGlobal('fetch', fetchMock);
    const result = await extractStatementText({ pages: [source], apiKey: 'test' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.draft.observations[0].source_excerpt).toBe(row.source_excerpt);
  });
  it('returns only drafts, meters each chunk, and never sends a password', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        choices: [
          {
            message: { content: JSON.stringify({ observations: [row], complete: true }) },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 20, completion_tokens: 20 }
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await extractStatementText({
      pages: [source],
      apiKey: 'test',
      meter: new AiUsageMeter()
    });
    expect(result.draft.document_type).toBe('statement');
    expect(result.draft.observations[0].amount).toBe(-42000);
    const request = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(request.provider).toMatchObject({ zdr: true, data_collection: 'deny' });
    expect(request.max_tokens).toBe(8192);
    expect(JSON.stringify(request)).not.toContain('password');
  });
});
