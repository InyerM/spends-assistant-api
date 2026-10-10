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
  it('builds exact source evidence from bounded line references instead of model quotations', () => {
    const referenced = {
      ...row,
      source_excerpt: 'Paraphrased by the model',
      source_line_start: 2,
      source_line_end: 2
    };
    expect(
      validateStatementChunk({ observations: [referenced], complete: true }, source).observations[0]
        .source_excerpt
    ).toBe(row.source_excerpt);
    for (const bounds of [
      [0, 2],
      [2, 3],
      [2, 1],
      [1.5, 2]
    ]) {
      expect(() =>
        validateStatementChunk(
          {
            observations: [
              { ...referenced, source_line_start: bounds[0], source_line_end: bounds[1] }
            ],
            complete: true
          },
          source
        )
      ).toThrow();
    }
    expect(() =>
      validateStatementChunk(
        { observations: [{ ...referenced, amount: 999 }], complete: true },
        source
      )
    ).toThrow('Ungrounded statement amount');
  });
  it('parses original amount text on the server and leaves unverified amounts for review', () => {
    const evidence = 'Synthetic Bancolombia COP 2026\n11/09 PURCHASE -42.000,25';
    const candidate = {
      ...row,
      amount: undefined,
      amount_text: '42.000,25',
      direction: 'outgoing',
      source_line_start: 2,
      source_line_end: 2,
      occurred_at: '2026-09-11'
    };
    expect(
      validateStatementChunk({ complete: true, observations: [candidate] }, evidence)
        .observations[0].amount
    ).toBe(-42000.25);
    const unknown = validateStatementChunk(
      { complete: true, observations: [{ ...candidate, amount_text: '99.000,00' }] },
      evidence
    ).observations[0];
    const grouped = validateStatementChunk(
      { complete: true, observations: [{ ...candidate, amount_text: '1 234,56' }] },
      'Synthetic Bancolombia COP 2026\n11/09 PURCHASE 1 234,56'
    );
    expect(grouped.observations[0].amount).toBe(-1234.56);
    expect(unknown.amount).toBeNull();
    expect(unknown.confidence).toBeLessThan(0.5);
    expect(unknown.source_excerpt).toBe('11/09 PURCHASE -42.000,25');
  });
  it('excludes statement summary headings without transaction evidence', () => {
    const candidate = {
      ...row,
      amount_text: null,
      direction: 'unknown',
      source_line_start: 1,
      source_line_end: 1,
      occurred_at: null
    };
    for (const label of ['Cargos', 'Abonos', '+ Saldo anterior', '+ Compras del mes']) {
      expect(
        validateStatementChunk(
          { complete: true, observations: [{ ...candidate, description: label }] },
          label
        ).observations
      ).toEqual([]);
    }
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
