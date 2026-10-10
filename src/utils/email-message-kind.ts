import { extractEmailEventEvidence } from './email-event-evidence';

export const EMAIL_MESSAGE_KINDS = [
  'purchase',
  'transfer',
  'income',
  'statement',
  'financial_document',
  'promotion',
  'informational',
  'security',
  'spam',
  'uncertain'
] as const;
export type EmailMessageKind = (typeof EMAIL_MESSAGE_KINDS)[number];

export function detectEmailMessageKind(subject: string, text: string): EmailMessageKind {
  if (subject === '[security_notice]') return 'security';
  if (/documentos de tu tarjeta|p[oó]liza|te damos la bienvenida a tu seguro/iu.test(subject))
    return 'financial_document';
  if (/\b(?:extractos?|estado de cuenta|account statement|bank statement)\b/iu.test(subject))
    return 'statement';
  if (
    /\b(?:c[oó]digo de (?:seguridad|verificaci[oó]n|acceso)|clave din[aá]mica|verification code|security code|verificaci[oó]n de seguridad|new payment method|otp|\[security_notice\])\b/iu.test(
      subject
    )
  )
    return 'security';
  if (/rechazad[ao]|no pudimos hacer tu pago/iu.test(subject)) return 'informational';
  const event = extractEmailEventEvidence(text);
  if (event.amount && !event.ambiguous) {
    if (event.type === 'income') return 'income';
    if (
      /\b(?:transferiste|transferencia realizada|enviaste|transfer completed|retiraste)\b/iu.test(
        text
      )
    )
      return 'transfer';
    return 'purchase';
  }
  const amount = /(?:\$|\bCOP|\bUSD)\s*[\d.,]+|\d[\d.,]*\s*(?:pesos?|d[oó]lares?|dollars?)/iu.test(
    text
  );
  if (amount) {
    if (
      /transacci[oó]n.*(?:aceptada|aprobada)|pago hecho|confirmaci[oó]n de transacci[oó]n/iu.test(
        subject
      )
    )
      return 'purchase';
    if (/tu viaje.*uber|tu viaje.*con uber/iu.test(subject) && /total/iu.test(text))
      return 'purchase';
    if (/informa pago Factura Programada/iu.test(text)) return 'purchase';
    if (
      /\b(?:transferiste|transferencia realizada|enviaste|transfer completed|retiraste)\b/iu.test(
        text
      )
    )
      return 'transfer';
    if (
      /\b(?:recibiste|recibimos tu pago|abono|consignaci[oó]n recibida|devoluci[oó]n|refund received)\b/iu.test(
        text
      )
    )
      return 'income';
    if (
      /\b(?:realizaste una compra|compraste|compra realizada|pagaste|pago realizado|cargo (?:a|en) tu cuenta|d[eé]bito autom[aá]tico|you paid|purchase completed)\b/iu.test(
        `${subject}\n${text}`
      )
    )
      return 'purchase';
  }
  if (
    /\b(?:oferta|promoci[oó]n|descuento|aprovecha|beneficios exclusivos|sale|newsletter|preventa|beneficio pendiente|s[aá]cale todo el jugo)\b/iu.test(
      subject
    )
  )
    return 'promotion';
  if (
    /\b(?:(?:cambios? en|actualizamos) (?:(?:los|el) )?(?:t[eé]rminos|condiciones|reglamento)|actualizaci[oó]n de (?:los )?t[eé]rminos|horarios? de atenci[oó]n|mantenimiento programado)\b/iu.test(
      `${subject}\n${text}`
    ) &&
    !amount
  )
    return 'informational';
  if (
    !amount &&
    /actualizaste tus topes|te identificaste con tu clave|actualizaste tu informaci[oó]n personal/iu.test(
      text
    )
  )
    return 'security';
  if (
    /solicitud de cancelaci[oó]n|solicitud de cita|cita coordinada|informaci[oó]n sobre tus datos personales|confirmaci[oó]n de reenv[ií]o/iu.test(
      subject
    )
  )
    return 'informational';
  if (/cuenta de cobro|\brenta\b/iu.test(subject)) return 'financial_document';
  return 'uncertain';
}
