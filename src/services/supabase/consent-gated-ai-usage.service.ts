import { AiUsageService, type TrackAiUsageParams } from './ai-usage.service';
import type { AiUsageMeter } from '../../ai/usage-meter';
import type { AiConsentScope } from './ai-consent.service';

interface ConsentChecker {
  require(userId: string, scope: AiConsentScope): Promise<void>;
}

const OPERATION_SCOPE: Record<TrackAiUsageParams['operation'], AiConsentScope> = {
  parse_expense: 'financial_text',
  generate_automation: 'financial_text',
  extract_document: 'document_images',
  triage_forwarded_email: 'forwarded_email',
  classify_forwarded_purchase: 'financial_text'
};

export class ConsentGatedAiUsageService extends AiUsageService {
  constructor(
    url: string,
    serviceKey: string,
    private readonly consent: ConsentChecker
  ) {
    super(url, serviceKey);
  }

  override async requireConsent(userId: string, scope: AiConsentScope): Promise<void> {
    await this.consent.require(userId, scope);
  }

  override async track<T>(
    params: TrackAiUsageParams,
    fn: (meter: AiUsageMeter) => Promise<T>,
    scope = OPERATION_SCOPE[params.operation]
  ): Promise<T> {
    if (params.operation !== 'parse_expense') await this.requireConsent(params.userId, scope);
    return super.track(params, fn);
  }
}
