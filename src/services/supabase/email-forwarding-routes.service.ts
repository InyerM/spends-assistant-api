import { BaseService } from './base.service';

export interface EmailForwardingRoute {
  user_id: string;
  address: string;
  created_at: string;
  confirmation_received_at: string | null;
  verification_text: string | null;
}

const fields = 'user_id,address,created_at,confirmation_received_at,verification_text';

function newAddress(domain: string): string {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return `capture+${token}@${domain}`;
}

export class EmailForwardingRoutesService extends BaseService {
  async getForUser(userId: string): Promise<EmailForwardingRoute | null> {
    const rows = await this.fetch<EmailForwardingRoute[]>(
      `/rest/v1/email_forwarding_routes?select=${fields}&user_id=eq.${encodeURIComponent(userId)}&limit=1`
    );
    return rows[0] ?? null;
  }

  async getByAddress(address: string): Promise<EmailForwardingRoute | null> {
    const rows = await this.fetch<EmailForwardingRoute[]>(
      `/rest/v1/email_forwarding_routes?select=${fields}&address=eq.${encodeURIComponent(address)}&limit=1`
    );
    return rows[0] ?? null;
  }

  async createForUser(userId: string, domain: string): Promise<EmailForwardingRoute> {
    const existing = await this.getForUser(userId);
    if (existing) return existing;
    const address = newAddress(domain);
    const response = await fetch(`${this.url}/rest/v1/email_forwarding_routes`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ user_id: userId, address })
    });
    if (response.status === 409) {
      const raced = await this.getForUser(userId);
      if (raced) return raced;
      throw new Error('Email forwarding address conflict');
    }
    if (!response.ok) throw new Error('Email forwarding address creation failed');
    const rows = (await response.json()) as EmailForwardingRoute[];
    if (!rows[0]) throw new Error('Email forwarding address creation failed');
    return rows[0];
  }

  async deleteForUser(userId: string): Promise<void> {
    await this.fetch<unknown>(
      `/rest/v1/email_forwarding_routes?user_id=eq.${encodeURIComponent(userId)}`,
      { method: 'DELETE' }
    );
  }

  async recordConfirmation(userId: string, address: string, text: string): Promise<void> {
    await this.fetch<unknown>(
      `/rest/v1/email_forwarding_routes?user_id=eq.${encodeURIComponent(userId)}&address=eq.${encodeURIComponent(address)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          confirmation_received_at: new Date().toISOString(),
          verification_text: text.slice(0, 2048)
        })
      }
    );
  }
}
