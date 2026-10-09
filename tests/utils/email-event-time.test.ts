import { describe, expect, it } from 'vitest';
import { validateEmailEventTime } from '../../src/utils/date';

describe('AI email event time evidence', () => {
  it.each([
    ['02/10/26 a las 16:31', '16:31'],
    ['2026-10-02 a las 16:31:24', '16:31'],
    ['2 de octubre de 2026. Hora 4:31 p.m.', '16:31'],
    ['02/10/2026 a las 12:00 a.m.', '00:00'],
    ['02/10/2026 a las 12:00 p.m.', '12:00']
  ])('validates original transaction time %s', (stamp, time) => {
    const quote = `Pago de $15,800 el ${stamp}.`;
    expect(validateEmailEventTime(`Bank notice\n${quote}`, '2026-10-02', time, quote)).toBe(
      `2026-10-02T${time}:00-05:00`
    );
  });

  it('accepts line wraps without rewriting the evidence', () => {
    const quote = 'Pago de $15,800 el 02/10/2026 a las 16:31.';
    expect(
      validateEmailEventTime(quote.replace('a las', 'a\nlas'), '2026-10-02', '16:31', quote)
    ).toBe('2026-10-02T16:31:00-05:00');
  });

  it.each([
    ['Pago de $15,800 el 02/10/2026.', '16:31'],
    ['Pago de $15,800 el 02/10/2026 a las 25:31.', '25:31'],
    ['Pago de $15,800 el 02/10/2026 a las 16:61.', '16:61'],
    ['Pago de $15,800 el 02/10/2026 o 03/10/2026 a las 16:31.', '16:31'],
    ['Pago de $15,800. Vencimiento 02/10/2026 16:31.', '16:31']
  ])('rejects missing, invalid or ambiguous evidence %s', (quote, time) => {
    expect(validateEmailEventTime(quote, '2026-10-02', time, quote)).toBeNull();
  });
});
