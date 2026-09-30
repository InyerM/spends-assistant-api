const ISO_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/u;
const RECEIPT_PREFIX = /^\[Recibido: (\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?\]/u;

function validParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): boolean {
  return (
    year >= 1900 &&
    year <= 2100 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate() &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59
  );
}

function parseIsoWithZone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = ISO_WITH_ZONE.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zone] = match;
  if (!validParts(+year, +month, +day, +hour, +minute, +second)) return null;
  if (zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4, 6) > 59)) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}

function parseReceiptPrefix(rawText: string): string | null {
  const match = RECEIPT_PREFIX.exec(rawText);
  if (!match) return null;
  const [, day, month, year, hour, minute, second = '00'] = match;
  if (!validParts(+year, +month, +day, +hour, +minute, +second)) return null;
  return parseIsoWithZone(`${year}-${month}-${day}T${hour}:${minute}:${second}-05:00`);
}

/** Return only an original SMS receipt instant, never a bank event or ingest time. */
export function resolveShortcutReceiptAt(rawText: string, provided: unknown): string | null {
  const explicit = provided === undefined ? null : parseIsoWithZone(provided);
  if (provided !== undefined && !explicit) return null;
  const hasPrefix = rawText.startsWith('[Recibido:');
  const prefixed = hasPrefix ? parseReceiptPrefix(rawText) : null;
  if (hasPrefix && !prefixed) return null;
  if (explicit && prefixed && explicit !== prefixed) return null;
  return explicit ?? prefixed;
}
