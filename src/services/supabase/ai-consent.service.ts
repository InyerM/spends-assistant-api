import { BaseService } from './base.service';

export const AI_CONSENT_VERSION = 'external-ai-v1';
export const AI_CONSENT_SCOPES = ['financial_text', 'document_images', 'forwarded_email'] as const;
export type AiConsentScope = (typeof AI_CONSENT_SCOPES)[number];

interface ConsentRow {
  scope: AiConsentScope;
  version: string;
  granted_at: string | null;
  revoked_at: string | null;
}

export interface AiConsentState {
  version: typeof AI_CONSENT_VERSION;
  consents: Record<AiConsentScope, boolean>;
}

export class AiConsentRequiredError extends Error {
  readonly code = 'AI_CONSENT_REQUIRED';

  constructor(readonly scope: AiConsentScope) {
    super('AI consent required');
  }
}

export class AiConsentUnavailableError extends Error {
  readonly code = 'AI_CONSENT_UNAVAILABLE';

  constructor() {
    super('AI consent unavailable');
  }
}

export class AiConsentService extends BaseService {
  async getState(userId: string): Promise<AiConsentState> {
    const params = new URLSearchParams({
      select: 'scope,version,granted_at,revoked_at',
      user_id: `eq.${userId}`
    });
    let rows: ConsentRow[];
    try {
      rows = await this.fetch<ConsentRow[]>(`/rest/v1/ai_consent_decisions?${params}`);
    } catch {
      throw new AiConsentUnavailableError();
    }
    if (!Array.isArray(rows)) throw new AiConsentUnavailableError();
    const consents: AiConsentState['consents'] = {
      financial_text: false,
      document_images: false,
      forwarded_email: false
    };
    for (const row of rows) {
      if (AI_CONSENT_SCOPES.includes(row.scope)) {
        consents[row.scope] =
          row.version === AI_CONSENT_VERSION && !!row.granted_at && !row.revoked_at;
      }
    }
    return { version: AI_CONSENT_VERSION, consents };
  }

  async require(userId: string, scope: AiConsentScope): Promise<void> {
    const state = await this.getState(userId);
    if (!state.consents[scope]) throw new AiConsentRequiredError(scope);
  }

  async setDecision(
    userId: string,
    scope: AiConsentScope,
    granted: boolean,
    version: string
  ): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.fetch<unknown>('/rest/v1/ai_consent_decisions?on_conflict=user_id,scope', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({
          user_id: userId,
          scope,
          version,
          granted_at: granted ? now : null,
          revoked_at: granted ? null : now
        })
      });
    } catch {
      throw new AiConsentUnavailableError();
    }
  }
}
