import { describe, expect, it } from 'vitest';
import {
  extractEmailEventEvidence,
  validateAiEmailFacts
} from '../../src/utils/email-event-evidence';

describe('bank-independent event evidence', () => {
  it.each([
    [
      'Banco informa pago Factura Programada CLUB HOGAR Ref 112233 por $33.812,00 desde Aho*2468. 11/09/2026.',
      '33812.00',
      '2026-09-11',
      null,
      '2468'
    ],
    [
      'Recibiste una transferencia de ACME por $1,595,669.00 en tu cuenta *2468 el 27/09/26 a las 09:40.',
      '1595669.00',
      '2026-09-27',
      '09:40',
      '2468'
    ],
    [
      'Realizaste una compra en HOSTING SERVICE por $68,537\nOrigen tarjeta de crédito •1357\nFecha 3 de octubre de 2026\nHora 11:34 a.m.',
      '68537.00',
      '2026-10-03',
      '11:34',
      '1357'
    ],
    [
      'Banco X: pagaste $16,800.00 por codigo QR desde tu cuenta *2468 a la llave 0060923745 el 02/10/2026 a las 16:31.',
      '16800.00',
      '2026-10-02',
      '16:31',
      '2468'
    ],
    [
      'Banco Y: Compra aprobada COP 45.900,50 con tarjeta de débito *2468 el 2026-10-01 20:07.',
      '45900.50',
      '2026-10-01',
      '20:07',
      '2468'
    ],
    [
      'Purchase completed USD 19.99 with card ending in 4321 on 2026-09-11 at 8:05 PM.',
      '19.99',
      '2026-09-11',
      '20:05',
      '4321'
    ]
  ])('extracts each field independently: %s', (message, amount, date, time, sourceLastFour) => {
    expect(extractEmailEventEvidence(message)).toMatchObject({
      amount,
      date,
      time,
      sourceLastFour
    });
  });
  it.each([
    ['Pago completado. Valor: 33.812,00 COP. Fecha: 11/09/2026. Hora: 09:05.', '33812.00', 'COP'],
    ['Payment completed. Amount: USD 19.99. Date: 2026-09-11. Time: 09:05.', '19.99', 'USD'],
    ['Compra aprobada. Importe: 45.900,50. 11/09/2026 09:05.', '45900.50', null]
  ])('supports monetary labels and currency suffixes: %s', (message, amount, currency) => {
    expect(extractEmailEventEvidence(message)).toMatchObject({
      amount,
      currency,
      date: '2026-09-11',
      time: '09:05'
    });
  });
  it('does not take the hour from headers, service hours or a tracking identifier', () => {
    expect(
      extractEmailEventEvidence(
        'Date: 11/09/2026 12:03\nPago Factura Programada por $33.812,00 desde Aho*2468. 11/09/2026. Inquietudes 6045109095. Horario 18:00. TRNUID: 123456789'
      )
    ).toMatchObject({ amount: '33812.00', date: '2026-09-11', time: null });
  });
  it.each([
    'Factura por $50.000 vence el 11/09/2026.',
    'Oferta: compra por $50.000 hasta 11/09/2026.',
    'Pago rechazado por $50.000 el 11/09/2026.',
    'Código de seguridad para autorizar compra de $50.000 el 11/09/2026.'
  ])('does not treat unsettled messages as completed: %s', (message) => {
    expect(extractEmailEventEvidence(message).amount).toBeNull();
  });
  it('withholds ambiguous multi-event amounts and times', () => {
    expect(
      extractEmailEventEvidence(
        'Pagaste $50.000 el 11/09/2026 12:03 y pagaste $60.000 el 12/09/2026 13:05.'
      )
    ).toMatchObject({ amount: null, date: null, time: null, ambiguous: true });
  });
  it('validates model-selected facts against an exact event quotation', () => {
    const message = 'Pago completado por COP 33.812,00 el 11/09/2026.';
    expect(
      validateAiEmailFacts(message, {
        amount: 33812,
        event_date: '2026-09-11',
        event_evidence: message
      })
    ).toMatchObject({ amount: '33812.00', date: '2026-09-11' });
    expect(
      validateAiEmailFacts(message, {
        amount: 99999,
        event_date: '2026-09-12',
        event_evidence: message
      })
    ).toMatchObject({ amount: null, date: null });
    expect(
      validateAiEmailFacts(message, {
        amount: 33812,
        event_date: '2026-09-11',
        event_evidence: 'Invented purchase $33.812,00 11/09/2026'
      })
    ).toMatchObject({ amount: null, date: null });
  });
});
