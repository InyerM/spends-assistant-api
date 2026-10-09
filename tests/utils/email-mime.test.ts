import { describe, expect, it } from 'vitest';
import { emailFingerprint, parseForwardedEmail } from '../../src/utils/email-mime';

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

function pdfMessage(content: string, name = 'statement.pdf', type = 'application/pdf') {
  return new TextEncoder().encode(
    [
      'Subject: Statement',
      'Content-Type: multipart/mixed; boundary="pdf"',
      '',
      '--pdf',
      'Content-Type: text/plain',
      '',
      'Your statement is attached.',
      '--pdf',
      `Content-Type: ${type}`,
      `Content-Disposition: attachment; filename="${name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(content).toString('base64'),
      '--pdf--'
    ].join('\r\n')
  ).buffer;
}

describe('PDF email evidence', () => {
  it('accepts a five-statement bank bundle and rejects more than eight PDFs', async () => {
    const buildBundle = (count: number): ArrayBuffer =>
      new TextEncoder().encode(
        [
          'Subject: Monthly bank statements',
          'Content-Type: multipart/mixed; boundary="bundle"',
          '',
          ...Array.from({ length: count }, (_, index) =>
            [
              '--bundle',
              'Content-Type: application/pdf',
              `Content-Disposition: attachment; filename="statement-${index}.pdf"`,
              '',
              '%PDF-1.7 statement'
            ].join('\r\n')
          ),
          '--bundle--'
        ].join('\r\n')
      ).buffer;
    expect((await parseForwardedEmail(buildBundle(5))).pdfAttachments).toHaveLength(5);
    await expect(parseForwardedEmail(buildBundle(9))).rejects.toThrow('Too many PDF attachments');
  });
  it('separates a bounded PDF from the readable mail body', async () => {
    const parsed = await parseForwardedEmail(pdfMessage('%PDF-1.7\nprivate statement'));
    expect(parsed.pdfAttachments).toHaveLength(1);
    expect(parsed.pdfAttachments?.[0].fileName).toBe('statement.pdf');
    expect(parsed.text).not.toContain('private statement');
    expect(parsed.text).toBe('Your statement is attached.');
  });
  it('ignores a forged PDF extension without a PDF signature', async () => {
    const parsed = await parseForwardedEmail(pdfMessage('not a PDF'));
    expect(parsed.pdfAttachments).toEqual([]);
  });
  it('rejects a PDF above the private bucket size limit', async () => {
    await expect(
      parseForwardedEmail(pdfMessage('%PDF-' + 'x'.repeat(5 * 1024 * 1024)))
    ).rejects.toThrow('PDF attachment too large');
  });
  it('distinguishes attachments in fallback fingerprints without a message ID', async () => {
    const first = await parseForwardedEmail(pdfMessage('%PDF-1.7\nfirst'));
    const second = await parseForwardedEmail(pdfMessage('%PDF-1.7\nsecond'));
    expect(await emailFingerprint(first)).not.toBe(await emailFingerprint(second));
  });
});
