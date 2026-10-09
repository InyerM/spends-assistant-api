import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailAttachmentsService } from '../../src/services/supabase/email-attachments.service';

const input = {
  userId: '11111111-1111-4111-8111-111111111111',
  inboxItemId: '22222222-2222-4222-8222-222222222222',
  externalId: 'a'.repeat(64),
  attachment: { fileName: 'statement.pdf', bytes: new TextEncoder().encode('%PDF-1.7\nprivate') }
};
const document = { id: 'document-id', file_name: 'statement.pdf', status: 'uploaded' };
const service = new EmailAttachmentsService('https://db.test', 'server-key');
afterEach(() => vi.unstubAllGlobals());
describe('private email PDF storage', () => {
  it('reuses existing owner evidence without uploading again', async () => {
    const request = vi.fn().mockResolvedValue(Response.json([document]));
    vi.stubGlobal('fetch', request);
    expect(await service.store(input)).toEqual(document);
    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0][0])).toContain(`user_id=eq.${input.userId}`);
  });
  it('uploads privately and preserves inbox provenance without creating financial rows', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ Key: 'private-key' }))
      .mockResolvedValueOnce(Response.json([document]));
    vi.stubGlobal('fetch', request);
    expect(await service.store(input)).toEqual(document);
    const upload = request.mock.calls[1];
    expect(String(upload[0])).toContain(`/storage/v1/object/documents/${input.userId}/`);
    expect(upload[1].headers['x-upsert']).toBe('false');
    const row = JSON.parse(request.mock.calls[2][1].body);
    expect(row).toMatchObject({
      user_id: input.userId,
      source_inbox_item_id: input.inboxItemId,
      mime_type: 'application/pdf',
      document_type: null,
      status: 'uploaded'
    });
    expect(row.email_attachment_key).toMatch(/^[a-f0-9]{64}$/u);
    expect(request.mock.calls.some(([url]) => String(url).includes('transactions'))).toBe(false);
  });
  it('cleans only the newly uploaded object if the document insert fails', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ Key: 'private-key' }))
      .mockResolvedValueOnce(new Response('database unavailable', { status: 500 }))
      .mockResolvedValueOnce(Response.json([]));
    vi.stubGlobal('fetch', request);
    await expect(service.store(input)).rejects.toThrow('Attachment metadata write failed');
    expect(request.mock.calls[3][1].method).toBe('DELETE');
    const cleanup = JSON.parse(request.mock.calls[3][1].body);
    expect(cleanup.prefixes).toEqual([expect.stringContaining(`${input.userId}/`)]);
  });
  it('handles a concurrent delivery conflict by preserving the winning object', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ Key: 'private-key' }))
      .mockResolvedValueOnce(new Response('conflict', { status: 409 }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json([document]));
    vi.stubGlobal('fetch', request);
    expect(await service.store(input)).toEqual(document);
    expect(request.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(
      1
    );
  });
});
