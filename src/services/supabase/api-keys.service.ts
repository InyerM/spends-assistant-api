import { BaseService } from './base.service';

interface UserApiKey {
  user_id: string;
  is_active: boolean;
}

export class ApiKeysService extends BaseService {
  async resolveUser(apiKey: string): Promise<string | null> {
    const keyHash = await this.hashKey(apiKey);

    const keys = await this.fetch<UserApiKey[]>(
      `/rest/v1/user_api_keys?key_hash=eq.${keyHash}&is_active=eq.true&select=user_id`,
    );

    if (keys.length === 0) return null;

    // Update last_used_at asynchronously (best-effort)
    this.fetch(
      `/rest/v1/user_api_keys?key_hash=eq.${keyHash}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ last_used_at: new Date().toISOString() }),
      },
    ).catch(() => {
      // Ignore errors on last_used_at update
    });

    return keys[0].user_id;
  }

  private async hashKey(key: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(key);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}
