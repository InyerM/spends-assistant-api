import { BaseService } from './base.service';

export interface CreateShortcutInboxItemInput {
  userId: string;
  source: string;
  receivedAt: string;
  rawText: string;
}

export interface CreateForwardedInboxItemInput extends CreateShortcutInboxItemInput {
  externalId: string;
  triageStatus?: 'pending' | 'non_transaction';
}

interface InboxItem {
  id: string;
  idempotency_key: string;
  external_id: string | null;
  status: string;
  source: string;
  user_id: string;
  received_at: string;
  raw_text: string;
}

function normalizeText(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en');
}

async function fingerprint(source: string, text: string, receivedAt: string): Promise<string> {
  const payload = JSON.stringify([source, 'fallback', normalizeText(text), receivedAt]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class ShortcutInboxService extends BaseService {
  async createForwardedPending(input: CreateForwardedInboxItemInput): Promise<void> {
    if (
      input.source !== 'forwarded_email' ||
      !/^[a-f0-9]{64}$/u.test(input.externalId) ||
      input.rawText.length > 4096 ||
      normalizeText(input.rawText).length === 0
    ) {
      throw new Error('Invalid forwarded inbox item');
    }
    const key = await fingerprint(input.source, input.externalId, '');
    const row = {
      user_id: input.userId,
      source: input.source,
      external_id: input.externalId,
      received_at: new Date(input.receivedAt).toISOString(),
      raw_text: input.rawText,
      idempotency_key: key,
      status: input.triageStatus ?? 'pending'
    };
    const response = await fetch(`${this.url}/rest/v1/shortcut_inbox_items`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(row)
    });
    if (response.ok) return;
    if (response.status !== 409) throw new Error('Forwarded inbox write failed');

    const existing = await this.fetch<InboxItem[]>(
      `/rest/v1/shortcut_inbox_items?select=id,user_id,source,external_id,received_at,raw_text,idempotency_key,status&user_id=eq.${encodeURIComponent(input.userId)}&source=eq.forwarded_email&external_id=eq.${input.externalId}&limit=1`
    );
    const match = existing[0];
    if (
      !match ||
      match.user_id !== input.userId ||
      match.source !== input.source ||
      match.external_id !== input.externalId ||
      match.idempotency_key !== key ||
      normalizeText(match.raw_text) !== normalizeText(input.rawText)
    ) {
      throw new Error('Forwarded inbox identity conflict');
    }
  }

  async createPending(input: CreateShortcutInboxItemInput): Promise<void> {
    if (
      !/^[a-z][a-z0-9_-]{1,39}$/u.test(input.source) ||
      input.rawText.length > 4096 ||
      normalizeText(input.rawText).length === 0
    ) {
      throw new Error('Invalid Shortcut inbox item');
    }
    const receivedAt = new Date(input.receivedAt).toISOString();
    const key = await fingerprint(input.source, input.rawText, receivedAt);
    const row = {
      user_id: input.userId,
      source: input.source,
      external_id: null,
      received_at: receivedAt,
      raw_text: input.rawText,
      idempotency_key: key,
      status: 'pending'
    };
    const response = await fetch(`${this.url}/rest/v1/shortcut_inbox_items`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(row)
    });
    if (response.ok) return;
    if (response.status !== 409) throw new Error('Shortcut inbox write failed');

    const lookup = await fetch(
      `${this.url}/rest/v1/shortcut_inbox_items?select=id,user_id,source,external_id,received_at,raw_text,idempotency_key,status&user_id=eq.${encodeURIComponent(input.userId)}&idempotency_key=eq.${key}&limit=1`,
      { headers: this.headers }
    );
    if (!lookup.ok) throw new Error('Shortcut inbox lookup failed');
    const existing = (await lookup.json()) as InboxItem[];
    const match = existing[0];
    if (
      !match ||
      match.user_id !== input.userId ||
      match.source !== input.source ||
      match.external_id !== null ||
      match.idempotency_key !== key ||
      match.received_at !== receivedAt ||
      normalizeText(match.raw_text) !== normalizeText(input.rawText)
    ) {
      throw new Error('Shortcut inbox identity conflict');
    }
  }
}
