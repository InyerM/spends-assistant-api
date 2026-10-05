import PostalMime from 'postal-mime';

const namedEntities: Record<string, string> = {
  amp: '&',
  apos: "'",
  quot: '"',
  lt: '<',
  gt: '>',
  nbsp: ' ',
  copy: '©',
  bull: '•',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  ntilde: 'ñ',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  Ntilde: 'Ñ'
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]+);/giu, (entity, code: string) => {
    if (code[0] !== '#') return namedEntities[code] ?? entity;
    const numeric =
      code[1]?.toLowerCase() === 'x'
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
    return numeric > 0 && numeric <= 0x10ffff && !(numeric >= 0xd800 && numeric <= 0xdfff)
      ? String.fromCodePoint(numeric)
      : entity;
  });
}

export interface ParsedForwardedEmail {
  sender: string | null;
  subject: string;
  text: string;
  messageId: string | null;
  date: string;
}

function plainFromHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ')
    .replace(
      /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu,
      (_match, href: string, label: string) => {
        try {
          const url = new URL(href.replace(/&amp;/giu, '&'));
          return url.protocol === 'https:' &&
            (url.hostname === 'mail.google.com' || url.hostname === 'mail-settings.google.com')
            ? `${label} ${url.toString()}`
            : label;
        } catch {
          return label;
        }
      }
    )
    .replace(/<br\s*\/?\s*>|<\/p\s*>|<\/div\s*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ');
}

function cleanText(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (code >= 32 && code !== 127) || code === 9 || code === 10 || code === 13;
    })
    .join('')
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export async function parseForwardedEmail(raw: ArrayBuffer): Promise<ParsedForwardedEmail> {
  const email = await PostalMime.parse(raw, {
    maxNestingDepth: 20,
    maxRfc822NestingDepth: 2,
    maxHeadersSize: 16 * 1024
  });
  return {
    sender: cleanText(email.from?.address ?? '').slice(0, 254) || null,
    subject: cleanText(email.subject ?? '').slice(0, 300),
    text: cleanText(decodeHtmlEntities(email.text || plainFromHtml(email.html ?? ''))),
    messageId: email.messageId?.trim().slice(0, 256) || null,
    date: email.date?.trim().slice(0, 128) ?? ''
  };
}

export async function emailFingerprint(email: ParsedForwardedEmail): Promise<string> {
  const identity = email.messageId
    ? ['message-id', email.messageId.toLowerCase()]
    : ['content', email.subject, email.date, email.text];
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(identity))
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function inboxText(email: ParsedForwardedEmail): string {
  const full = [email.sender ? `From (unverified): ${email.sender}` : '', email.subject, email.text]
    .filter(Boolean)
    .join('\n\n');
  return full.length <= 4096 ? full : `${full.slice(0, 4076)}\n[Content truncated]`;
}
