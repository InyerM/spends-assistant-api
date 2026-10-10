import { describe, expect, it } from 'vitest';
import { detectEmailMessageKind } from '../../src/utils/email-message-kind';

describe('email message labels', () => {
  it.each([
    ['Generic notification', 'Payment completed. Amount: USD 19.99. Date: 2026-09-11.', 'purchase'],
    [
      'Generic notification',
      'Pago completado. Valor: 33.812,00 COP. Fecha: 11/09/2026.',
      'purchase'
    ],
    ['Alertas', 'Actualizaste tus topes en Sucursal Virtual.', 'security'],
    ['Pago rechazado', 'No fue posible realizar el pago por $15000000.', 'informational'],
    ['Tu viaje Uber del domingo', 'Total COP 10330. Pagos Mastercard 9989.', 'purchase'],
    [
      'Alertas',
      'Bancolombia informa pago Factura Programada por $33812 desde Aho*2651.',
      'purchase'
    ],
    ['Alertas', 'Retiraste $1000000 en cajero desde tu cuenta.', 'transfer'],
    ['[security_notice]', '', 'security'],
    [
      'Actualizamos el Reglamento de tu Cuenta de Ahorros',
      'Cambios del reglamento.',
      'informational'
    ],
    ['Solo para ti preventa exclusiva', 'Reserva tu entrada por $50000.', 'promotion'],
    ['Transacción #123 ACEPTADA en ePayco', 'Pago factura: $87950 COP', 'purchase'],
    [
      'Aquí están los documentos de tu Tarjeta de Crédito',
      'PDF attachment received.',
      'financial_document'
    ],
    ['Alertas', 'Compraste COP62.335,00 en RAPPI con tu T.Cred *4899', 'purchase'],
    ['Compra realizada', 'Realizaste una compra en HOSTINGER por $68,537', 'purchase'],
    [
      'Notificación',
      'Transferiste $36,000 desde tu cuenta *2651 a la cuenta *3248292427',
      'transfer'
    ],
    ['Movimiento', 'Recibiste un abono de COP 120000 en tu cuenta', 'income'],
    ['Extracto octubre', 'Compras: $50000. Pago mínimo $10000.', 'statement'],
    [
      'Aprovecha este descuento',
      'Compra productos desde $10000 con 50% de descuento.',
      'promotion'
    ],
    ['Código de seguridad', 'Tu código de seguridad es 123456', 'security'],
    [
      'Compra realizada',
      'Realizaste una compra por $62000. Nunca compartas tu código de seguridad.',
      'purchase'
    ],
    ['Información', 'Cambios en los términos y condiciones del servicio.', 'informational'],
    ['Mensaje', 'Contenido que no permite saber qué ocurrió.', 'uncertain']
  ])(
    'labels %s without conflating advertised prices and actual payments',
    (subject, text, kind) => {
      expect(detectEmailMessageKind(subject, text)).toBe(kind);
    }
  );
  it('preserves financial evidence when a promotional subject contains an actual transaction', () => {
    expect(detectEmailMessageKind('Beneficios exclusivos', 'Pagaste $12500 desde tu cuenta.')).toBe(
      'purchase'
    );
  });
});
