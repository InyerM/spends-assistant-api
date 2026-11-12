import { describe, expect, it } from 'vitest';
import {
  scoreRows,
  withFallback,
  parseModelJson,
  reserveBudget
} from '../../../scripts/eval/model-comparison/comparison';

describe('synthetic model comparison', () => {
  it('records fenced JSON normalization without accepting malformed output', () => {
    expect(parseModelJson('```json\n{"rows":[]}\n```')).toEqual({
      data: { rows: [] },
      strict: false
    });
    expect(parseModelJson('{"rows":[]}').strict).toBe(true);
    expect(parseModelJson('not json').data).toBe(null);
  });
  const rows = [{ reference: 'S1', amount: -12.5, currency: 'USD', date: '2026-11-01' }];
  it('rejects sign, currency, date, missing and duplicate row errors', () => {
    expect(scoreRows(rows, rows).pass).toBe(true);
    for (const change of [{ amount: 12.5 }, { currency: 'COP' }, { date: '2026-01-11' }]) {
      expect(scoreRows(rows, [{ ...rows[0], ...change }]).pass).toBe(false);
    }
    expect(scoreRows(rows, []).pass).toBe(false);
    expect(scoreRows(rows, [...rows, ...rows]).pass).toBe(false);
  });
  it('falls back after invalid JSON but keeps a valid primary', async () => {
    let calls = 0;
    const secondary = async () => {
      calls++;
      return { rows };
    };
    expect((await withFallback(async () => null, secondary)).fallback).toBe(true);
    expect((await withFallback(async () => ({ rows }), secondary)).fallback).toBe(false);
    expect(calls).toBe(1);
  });
  it('rejects partial schema and uses fallback after transport errors', async () => {
    expect(
      (
        await withFallback(
          async () => ({ rows: [{ amount: 1 }] }),
          async () => ({ rows })
        )
      ).fallback
    ).toBe(true);
    expect(
      (
        await withFallback(
          async () => {
            throw new Error('timeout');
          },
          async () => ({ rows })
        )
      ).fallback
    ).toBe(true);
  });
  it('rejects malformed dates, currencies and incomplete primary coverage', async () => {
    for (const change of [{ currency: 'pesos' }, { date: '2026-99-99' }]) {
      expect(scoreRows(rows, [{ ...rows[0], ...change }]).schemaValid).toBe(false);
    }
    const result = await withFallback(
      async () => ({ rows: [] }),
      async () => ({ rows }),
      (data) => scoreRows(rows, (data as { rows: unknown }).rows).pass
    );
    expect(result.fallback).toBe(true);
  });
  it('reserves worst case before calls and rejects unpriced routes', () => {
    expect(reserveBudget(1.99, 0.02, 2)).toBe(false);
    expect(reserveBudget(0, Number.NaN, 2)).toBe(false);
    expect(reserveBudget(0, 0.1, 2)).toBe(true);
  });
});
