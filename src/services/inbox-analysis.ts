import { createSupabaseServices } from './supabase';
import type { Env } from '../types/env';
import type { InboxAnalysisLease, InboxAnalysisQueueJob } from '../types/inbox-analysis';
import { AiConsentRequiredError } from './supabase/ai-consent.service';
import { suggestForwardedEmail } from '../ai/forwarded-email-suggestion';
import { extractEmailEventEvidence } from '../utils/email-event-evidence';
import { buildInboxAnalysisProposal } from '../utils/inbox-analysis-proposal';

/** Generates review suggestions only. SQL leases guard replay and discarded captures. */
export async function processInboxAnalysisLease(
  lease: InboxAnalysisLease,
  env: Env
): Promise<void> {
  const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  try {
    const item = await services.inboxAnalysis.item(lease.user_id, lease.inbox_item_id);
    if (!item || item.status !== 'pending') return;
    if (item.source === 'forwarded_email') {
      const route = await services.forwardingRoutes.getForUser(lease.user_id);
      if (!route?.confirmation_received_at || !route.user_confirmed_at) {
        await services.inboxAnalysis.fail(lease, 'unverified_source', true);
        return;
      }
    }
    if (
      [
        'statement',
        'financial_document',
        'promotion',
        'informational',
        'security',
        'spam'
      ].includes(item.message_kind ?? '')
    ) {
      await services.inboxAnalysis.fail(lease, 'invalid_source', true);
      return;
    }
    const scope = item.source === 'forwarded_email' ? 'forwarded_email' : 'financial_text';
    await services.aiConsent.require(lease.user_id, scope);
    const evidence = extractEmailEventEvidence(item.raw_text);
    const [categories, accounts, history, rules] = await Promise.all([
      services.categories.getCategories(lease.user_id),
      services.accounts.getAccounts(lease.user_id),
      services.categoryReviewContext.history(
        lease.user_id,
        evidence.merchant ?? item.raw_text,
        evidence.type ?? ''
      ),
      services.automationRules.getAutomationRules(lease.user_id)
    ]);
    const reservation = await services.usage.incrementAiParses(lease.user_id);
    if (!reservation.allowed) {
      await services.inboxAnalysis.fail(lease, 'quota_limit', true);
      return;
    }
    const suggestion = await suggestForwardedEmail(
      item.raw_text,
      categories,
      env.OPENROUTER_API_KEY,
      env.OPENROUTER_TEXT_MODEL ?? 'deepseek/deepseek-v4.1-flash',
      lease.user_id,
      services.aiUsage,
      { history, rules, consentScope: scope, allowWebSearch: false, includeExplanation: true }
    );
    const proposal = buildInboxAnalysisProposal(
      item,
      suggestion,
      accounts,
      categories,
      rules,
      services.automationRules
    );
    await services.inboxAnalysis.complete(lease, proposal);
  } catch (error) {
    await services.inboxAnalysis.fail(
      lease,
      error instanceof AiConsentRequiredError ? 'consent_required' : 'provider_unavailable',
      error instanceof AiConsentRequiredError
    );
  }
}

export async function processInboxAnalysisJob(job: InboxAnalysisQueueJob, env: Env): Promise<void> {
  const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const [lease] = await services.inboxAnalysis.claim(1, job.inboxItemId);
  if (lease) await processInboxAnalysisLease(lease, env);
}

export async function dispatchInboxAnalysis(
  env: Env,
  userId?: string,
  ids?: string[]
): Promise<void> {
  if (!env.EMAIL_AUTH_QUEUE) return;
  const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const jobs = await services.inboxAnalysis.due(20, userId, ids);
  if (jobs.length)
    await env.EMAIL_AUTH_QUEUE.sendBatch(
      jobs.map((job) => ({
        body: { kind: 'inbox_analysis', inboxItemId: job.inbox_item_id }
      }))
    );
}
