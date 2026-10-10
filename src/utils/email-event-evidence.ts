/** Shared verbatim with web and native; run scripts/sync-email-evidence.ts after edits. */
export interface EmailEventEvidence {
  amount: string | null;
  currency: 'COP' | 'USD' | null;
  date: string | null;
  time: string | null;
  sourceLastFour: string | null;
  sourceKind: 'credit' | 'debit' | null;
  type: 'expense' | 'income' | null;
  merchant: string | null;
  ambiguous: boolean;
}

export function normalizeEmailAmount(raw: string): string | null {
  const token = raw.replace(/[.,]+$/u, '');
  let decimal: string;
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/u.test(token))
    decimal = token.replaceAll('.', '').replace(',', '.');
  else if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/u.test(token)) decimal = token.replaceAll(',', '');
  else if (/^\d+(?:[.,]\d{1,2})?$/u.test(token)) decimal = token.replace(',', '.');
  else return null;
  const amount = Number(decimal);
  return Number.isFinite(amount) && amount > 0 && amount <= 9_999_999_999_999
    ? amount.toFixed(2)
    : null;
}

function unique<T>(values: T[]): T | null {
  const distinct = [...new Set(values)];
  return distinct.length === 1 ? distinct[0] : null;
}

function validDate(year: number, month: number, day: number): string | null {
  if (
    year < 2000 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate()
  )
    return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Exclude delivery metadata, tracking codes, image URLs and security footers before extraction. */
export function emailEventBody(message: string): string {
  return message
    .replace(/^\s*(?:From(?: \(unverified\))?|To|Date|Sent|Received|Subject):[^\n]*$/gimu, '')
    .replace(
      /\b(?:saldo(?: disponible)?|available balance|balance)\s*:\s*(?:COP|USD|\$)\s*[\d.,]+/giu,
      ''
    )
    .replace(/https?:\/\/[^\s\]]+/giu, '')
    .replace(/&#(\d+);/gu, (_, value: string) =>
      String.fromCodePoint(Math.min(Number(value), 0x10ffff))
    )
    .replace(
      /&(?:aacute|eacute|iacute|oacute|uacute|ntilde|nbsp|amp);/giu,
      (value) =>
        ({
          '&aacute;': 'á',
          '&eacute;': 'é',
          '&iacute;': 'í',
          '&oacute;': 'ó',
          '&uacute;': 'ú',
          '&ntilde;': 'ñ',
          '&nbsp;': ' ',
          '&amp;': '&'
        })[value.toLowerCase()] ?? value
    )
    .split(
      /\b(?:inquietudes|dudas|si tienes dudas|si no reconoces|si tiene alguna|este es una notificaci[oó]n|aqu[ií] algunos consejos|horario de atenci[oó]n|support hours|TRNUID|copyright)\b/iu,
      1
    )[0]
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Partial evidence stays useful; absent, unsettled and conflicting facts remain unknown. */
export function extractEmailEventEvidence(message: string): EmailEventEvidence {
  const body = emailEventBody(message);
  const empty: EmailEventEvidence = {
    amount: null,
    currency: null,
    date: null,
    time: null,
    sourceLastFour: null,
    sourceKind: null,
    type: null,
    merchant: null,
    ambiguous: false
  };
  if (
    !/\b(?:compra(?:\s+(?:realizada|aprobada|por|en|de))|compraste|pagaste|pago|pagado|transferiste|transferencia|recibiste|retiro|retiraste|consignaste|abono|cobro|purchase|paid|payment|received|transfer)\b/iu.test(
      body
    )
  )
    return empty;
  if (
    /\b(?:oferta|promoci[oó]n|rechazad[oa]|declined|pendiente|pending|vencimiento|vence|due date|c[oó]digo de seguridad|verification code|autorizar)\b/iu.test(
      body
    )
  )
    return empty;
  const moneyTokens = new Map<number, { raw: string; currency: string | null }>();
  for (const match of body.matchAll(/(?:\b(COP|USD)\s*\$?|([$]))\s*([0-9][0-9.,]*)/giu)) {
    moneyTokens.set(match.index! + match[0].lastIndexOf(match[3]), {
      raw: match[3],
      currency: match[1] ? match[1].toUpperCase() : null
    });
  }
  for (const match of body.matchAll(/\b([0-9][0-9.,]*)\s*(COP|USD)\b/giu)) {
    moneyTokens.set(match.index!, { raw: match[1], currency: match[2].toUpperCase() });
  }
  for (const match of body.matchAll(
    /\b(?:valor|monto|importe|amount|total pagado)\s*[:=]\s*(?:(COP|USD)\s*\$?|\$)?\s*([0-9][0-9.,]*)/giu
  )) {
    moneyTokens.set(match.index! + match[0].lastIndexOf(match[2]), {
      raw: match[2],
      currency: match[1]
        ? match[1].toUpperCase()
        : (moneyTokens.get(match.index! + match[0].lastIndexOf(match[2]))?.currency ?? null)
    });
  }
  const tokens = [...moneyTokens.values()];
  const amounts = tokens
    .map((token) => normalizeEmailAmount(token.raw))
    .filter((value): value is string => value !== null);
  if (amounts.length === 0) return empty;
  const dates: string[] = [];
  for (const match of body.matchAll(
    /\b(?:(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})|(\d{4})-(\d{2})-(\d{2}))\b/gu
  )) {
    const value = match[4]
      ? validDate(Number(match[4]), Number(match[5]), Number(match[6]))
      : validDate(
          Number(match[3].length === 2 ? `20${match[3]}` : match[3]),
          Number(match[2]),
          Number(match[1])
        );
    if (value) dates.push(value);
  }
  const months = [
    'enero',
    'febrero',
    'marzo',
    'abril',
    'mayo',
    'junio',
    'julio',
    'agosto',
    'septiembre',
    'octubre',
    'noviembre',
    'diciembre'
  ];
  for (const match of body.matchAll(
    /\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+de\s+(\d{4})\b/giu
  )) {
    const value = validDate(
      Number(match[3]),
      months.indexOf(match[2].toLowerCase()) + 1,
      Number(match[1])
    );
    if (value) dates.push(value);
  }
  const times: string[] = [];
  for (const match of body.matchAll(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(?:([ap])\.?\s*m\.?)?/giu)) {
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    if (match[3]) {
      if (hour < 1 || hour > 12) continue;
      hour = (hour % 12) + (match[3].toLowerCase() === 'p' ? 12 : 0);
    }
    if (hour <= 23 && minute <= 59) times.push(`${String(hour).padStart(2, '0')}:${match[2]}`);
  }
  const clean = body.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '');
  const references: Array<{ suffix: string; kind: 'credit' | 'debit' | null }> = [];
  for (const match of clean.matchAll(
    /\b(?:desde\s+(?:(?:tu|la)\s+)?(?:cuenta|Aho)|en tu cuenta|from (?:your )?account)\s*[*•]+\s*(\d{4})\b/giu
  ))
    references.push({ suffix: match[1], kind: 'debit' });
  for (const match of clean.matchAll(
    /\b(?:T\.\s*(Cred(?:ito)?|Deb(?:ito)?)|(?:Origen )?tarjeta de (credito|debito))\s*[*•]+\s*(\d{4})\b/giu
  ))
    references.push({
      suffix: match[3],
      kind: /cred/iu.test(match[1] || match[2]) ? 'credit' : 'debit'
    });
  for (const match of clean.matchAll(/\bcard ending (?:in\s+)?(\d{4})\b/giu))
    references.push({ suffix: match[1], kind: null });
  const incoming = /\b(?:recibiste|consignaste|abono recibido|received)\b/iu.test(body);
  const merchant =
    /\b(?:compra en|purchase at)\s+(.{2,100}?)\s+(?:por|for)\s*(?:COP|USD|\$)/iu.exec(body)?.[1] ??
    /\bCompraste\s*(?:COP|USD|\$)\s*[\d.,]+\s+en\s+(.{2,100}?)(?=\s+con\s|,?\s+el\s)/iu.exec(
      body
    )?.[1] ??
    /\bpago Factura Programada\s+(.{2,100}?)\s+Ref\b/iu.exec(body)?.[1] ??
    null;
  const ambiguous =
    new Set(amounts).size > 1 ||
    new Set(dates).size > 1 ||
    new Set(times).size > 1 ||
    tokens.length > 1;
  return {
    amount: ambiguous ? null : unique(amounts),
    currency: unique(
      tokens
        .map((token) => token.currency)
        .filter((value): value is 'COP' | 'USD' => value === 'COP' || value === 'USD')
    ),
    date: ambiguous ? null : unique(dates),
    time: ambiguous ? null : unique(times),
    sourceLastFour: unique(references.map(({ suffix }) => suffix)),
    sourceKind: unique(references.map(({ kind }) => kind)),
    type: incoming ? 'income' : 'expense',
    merchant: merchant ? merchant.trim() : null,
    ambiguous
  };
}

/** A model may select a relevant excerpt, but cannot manufacture factual values. */
export function validateAiEmailFacts(
  message: string,
  result: Record<string, unknown>
): Pick<EmailEventEvidence, 'amount' | 'date' | 'sourceLastFour'> {
  const empty = { amount: null, date: null, sourceLastFour: null };
  if (typeof result.event_evidence !== 'string') return empty;
  const quote = result.event_evidence.replace(/\s+/gu, ' ').trim();
  if (
    !quote ||
    quote.length > 1000 ||
    !emailEventBody(message).includes(quote) ||
    extractEmailEventEvidence(message).ambiguous
  )
    return empty;
  const parsed = extractEmailEventEvidence(quote);
  return {
    amount: parsed.amount && Number(result.amount) === Number(parsed.amount) ? parsed.amount : null,
    date: result.event_date === parsed.date ? parsed.date : null,
    sourceLastFour: result.source_last_four === parsed.sourceLastFour ? parsed.sourceLastFour : null
  };
}
