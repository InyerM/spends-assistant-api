import PostalMime from 'postal-mime';

export interface ParsedForwardedEmail {
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
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>');
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
    subject: cleanText(email.subject ?? '').slice(0, 300),
    text: cleanText(email.text || plainFromHtml(email.html ?? '')),
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
  const full = [email.subject, email.text].filter(Boolean).join('\n\n');
  return full.length <= 4096 ? full : `${full.slice(0, 4076)}\n[Content truncated]`;
}
