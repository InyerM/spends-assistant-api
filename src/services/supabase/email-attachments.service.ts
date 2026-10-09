import { BaseService } from './base.service';
import { sha256Hex, type EmailPdfAttachment } from '../../utils/email-mime';

interface AttachmentDocument {
  id: string;
  file_name: string;
  status: string;
}

export class EmailAttachmentsService extends BaseService {
  private async find(userId: string, key: string): Promise<AttachmentDocument | null> {
    const rows = await this.fetch<AttachmentDocument[]>(
      `/rest/v1/documents?user_id=eq.${encodeURIComponent(userId)}&email_attachment_key=eq.${key}&select=id,file_name,status&limit=1`
    );
    return rows[0] ?? null;
  }

  async store(input: {
    userId: string;
    inboxItemId: string;
    externalId: string;
    attachment: EmailPdfAttachment;
  }): Promise<AttachmentDocument> {
    const { userId, inboxItemId, externalId, attachment } = input;
    const sha256 = await sha256Hex(attachment.bytes);
    const key = await sha256Hex(new TextEncoder().encode(JSON.stringify([externalId, sha256])));
    const existing = await this.find(userId, key);
    if (existing) return existing;
    const filePath = `${userId}/${crypto.randomUUID()}.pdf`;
    const uploaded = await fetch(`${this.url}/storage/v1/object/documents/${filePath}`, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/pdf', 'x-upsert': 'false' },
      body: new Uint8Array(attachment.bytes)
    });
    if (!uploaded.ok) throw new Error('Attachment upload failed');
    let removed = false;
    try {
      const response = await fetch(`${this.url}/rest/v1/documents`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          user_id: userId,
          file_name: attachment.fileName,
          file_path: filePath,
          mime_type: 'application/pdf',
          sha256,
          document_type: null,
          status: 'uploaded',
          source_inbox_item_id: inboxItemId,
          email_attachment_key: key
        })
      });
      if (!response.ok) {
        if (response.status === 409) {
          await this.removeUpload(filePath);
          removed = true;
          const winner = await this.find(userId, key);
          if (winner) return winner;
          throw new Error('Attachment metadata conflict');
        }
        throw new Error('Attachment metadata write failed');
      }
      const rows = (await response.json()) as AttachmentDocument[];
      if (!rows[0]?.id) throw new Error('Attachment metadata write failed');
      return rows[0];
    } catch (error) {
      if (!removed) await this.removeUpload(filePath);
      throw error;
    }
  }

  private async removeUpload(filePath: string): Promise<void> {
    const response = await fetch(`${this.url}/storage/v1/object/documents`, {
      method: 'DELETE',
      headers: this.headers,
      body: JSON.stringify({ prefixes: [filePath] })
    });
    if (!response.ok) throw new Error('Attachment cleanup failed');
  }
}
