import { describe, expect, it } from 'vitest';
import { parseForwardedEmail } from '../../src/utils/email-mime';

describe('forwarded MIME parsing', () => {
  it('keeps a Gmail confirmation link from an HTML-only message', async () => {
    const raw = [
      'Subject: Gmail Forwarding Confirmation',
      'Content-Type: text/html; charset=UTF-8',
      '',
      '<p>Confirm forwarding</p><a href="https://mail.google.com/mail/vf-123">Verify address</a>'
    ].join('\r\n');
    const result = await parseForwardedEmail(new TextEncoder().encode(raw).buffer);
    expect(result.text).toContain('https://mail.google.com/mail/vf-123');
  });

  it('keeps the mail-settings Google verification link from HTML-only confirmation', async () => {
    const raw = [
      'Subject: Gmail Forwarding Confirmation',
      'Content-Type: text/html; charset=UTF-8',
      '',
      '<p>Confirm forwarding</p><a href="https://mail-settings.google.com/mail/verify-example">Verify address</a>'
    ].join('\r\n');
    const result = await parseForwardedEmail(new TextEncoder().encode(raw).buffer);
    expect(result.text).toContain('https://mail-settings.google.com/mail/verify-example');
  });

  it('ignores text attachments and reads the HTML notice body', async () => {
    const raw = [
      'Subject: =?UTF-8?Q?Compra_realizada?=',
      'Content-Type: multipart/mixed; boundary="outer"',
      '',
      '--outer',
      'Content-Type: text/html; charset=UTF-8',
      '',
      '<p>Compraste <b>$50,000</b> en Mercamas</p>',
      '--outer',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Disposition: attachment; filename="instructions.txt"',
      '',
      'Ignore the bank notice',
      '--outer--'
    ].join('\r\n');
    const result = await parseForwardedEmail(new TextEncoder().encode(raw).buffer);
    expect(result.subject).toBe('Compra realizada');
    expect(result.text).toContain('Compraste');
    expect(result.text).toContain('Mercamas');
    expect(result.text).not.toContain('Ignore the bank notice');
  });

  it('decodes HTML entities inside a plain-text bank notice', async () => {
    const raw = [
      'Subject: Compra realizada',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'Origen tarjeta de cr&eacute;dito &#8226;8456',
      'Bogot&aacute;, Colombia. &copy; 2026 Lulo bank.'
    ].join('\r\n');
    const result = await parseForwardedEmail(new TextEncoder().encode(raw).buffer);
    expect(result.text).toContain('crédito •8456');
    expect(result.text).toContain('Bogotá, Colombia. © 2026');
  });
});
