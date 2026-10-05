import type { ParsedForwardedEmail } from '../utils/email-mime';

export interface ForwardedPurchase {
  amount: string;
  currency: 'COP';
  date: string;
  time: string;
  cardLastFour: string;
  merchant: string;
}

const months: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12
};

export function extractForwardedPurchase(
  email: ParsedForwardedEmail,
  receivedAt: string
): ForwardedPurchase | null {
  if (
    email.sender?.toLowerCase() !== 'notificaciones@lulobank.com' ||
    email.subject.trim().toLowerCase() !== 'compra realizada' ||
    /\b(?:USD|d[oó]lares?|pr[eé]stamo|cuota|devoluci[oó]n|reverso|anulaci[oó]n|autorizaci[oó]n)\b/iu.test(
      email.text
    )
  )
    return null;

  const purchases = [
    ...email.text.matchAll(/Realizaste una compra en ([^\n]+?) por (?:COP\s*)?\$\s*([\d.,]+)/giu)
  ];
  if (purchases.length !== 1) return null;
  const card = email.text.match(/Origen tarjeta de cr[eé]dito\s*[•*]\s*(\d{4})\b/iu);
  const dateMatch = email.text.match(/\bFecha\s+(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})\b/iu);
  const timeMatch = email.text.match(/\bHora\s+(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?/iu);
  if (!card || !dateMatch || !timeMatch) return null;

  const month = months[dateMatch[2].toLowerCase()];
  const day = Number(dateMatch[1]);
  const year = Number(dateMatch[3]);
  const hour12 = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (!month || day < 1 || day > 31 || hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (timeMatch[3].toLowerCase() === 'p' ? 12 : 0);
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
  const eventAt = new Date(`${date}T${time}-05:00`);
  const received = new Date(receivedAt);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(eventAt.getTime()) ||
    Number.isNaN(received.getTime()) ||
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() + 1 !== month ||
    calendarDate.getUTCDate() !== day ||
    eventAt.getTime() > received.getTime() + 5 * 60_000 ||
    eventAt.getTime() < received.getTime() - 31 * 24 * 60 * 60_000
  )
    return null;

  const rawAmount = purchases[0][2];
  if (!/^\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$/u.test(rawAmount)) return null;
  const amount = Number(rawAmount.replaceAll(',', ''));
  const merchant = purchases[0][1].trim();
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 999_999_999 ||
    merchant.length < 2 ||
    merchant.length > 100
  )
    return null;
  return {
    amount: amount.toFixed(2),
    currency: 'COP',
    date,
    time,
    cardLastFour: card[1],
    merchant
  };
}
