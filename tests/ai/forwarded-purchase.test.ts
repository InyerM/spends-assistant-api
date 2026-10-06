import { describe, expect, it } from 'vitest';
import { extractForwardedPurchase } from '../../src/ai/forwarded-purchase';
import type { ParsedForwardedEmail } from '../../src/utils/email-mime';

const receivedAt = '2026-10-05T18:00:00.000Z';

function notice(overrides: Partial<ParsedForwardedEmail> = {}): ParsedForwardedEmail {
  return {
    sender: 'notificaciones@lulobank.com',
    subject: 'Compra realizada',
    text: 'Compra realizada\nRealizaste una compra en SHEIN.COM por $188,165.52\nOrigen tarjeta de crédito •8456\nFecha 5 de octubre de 2026\nHora 12:24 p.m.\nSi no reconoces este movimiento, consulta la app de Lulo bank.',
    messageId: '<purchase-1@lulobank.com>',
    date: receivedAt,
    ...overrides
  };
}

describe('forwarded purchase extraction', () => {
  it('extracts one dated Lulo card purchase as COP evidence', () => {
    expect(extractForwardedPurchase(notice(), receivedAt)).toEqual({
      amount: '188165.52',
      currency: 'COP',
      date: '2026-10-05',
      time: '12:24:00',
      cardLastFour: '8456',
      merchant: 'SHEIN.COM'
    });
  });

  it('extracts the indented large purchase seen in HTML-derived Lulo text', () => {
    const received = '2026-10-06T20:42:35Z';
    expect(
      extractForwardedPurchase(
        notice({
          text: [
            '                    Realizaste una compra en CEA PRACTICAR DEL EJE por $1,550,000',
            'Origen tarjeta de crédito •8456',
            'Fecha 6 de octubre de 2026',
            'Hora 3:42 p.m.'
          ].join('\n')
        }),
        received
      )
    ).toEqual({
      amount: '1550000.00',
      currency: 'COP',
      date: '2026-10-06',
      time: '15:42:00',
      cardLastFour: '8456',
      merchant: 'CEA PRACTICAR DEL EJE'
    });
  });

  it('holds a card payment or loan payment for review', () => {
    expect(
      extractForwardedPurchase(
        notice({ subject: 'Pago hecho', text: 'Pagaste $15,000,000 de tu crédito.' }),
        receivedAt
      )
    ).toBeNull();
  });

  it('holds multiple purchases in one message for review', () => {
    const duplicate = notice();
    expect(
      extractForwardedPurchase(
        { ...duplicate, text: `${duplicate.text}\nRealizaste una compra en TUGO por $74,980` },
        receivedAt
      )
    ).toBeNull();
  });

  it('holds a notice with unknown currency or account suffix', () => {
    expect(
      extractForwardedPurchase(
        notice({ text: notice().text.replace('$188,165.52', 'USD 188.17') }),
        receivedAt
      )
    ).toBeNull();
    expect(
      extractForwardedPurchase(
        notice({
          text: notice().text.replace('•8456', '•0000').replace('Origen tarjeta de crédito ', '')
        }),
        receivedAt
      )
    ).toBeNull();
  });

  it('holds a stale or future event for review', () => {
    expect(extractForwardedPurchase(notice(), '2026-12-05T18:00:00.000Z')).toBeNull();
    expect(extractForwardedPurchase(notice(), '2026-10-04T18:00:00.000Z')).toBeNull();
  });
});
