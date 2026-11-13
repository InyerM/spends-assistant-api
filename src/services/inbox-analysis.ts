import { createSupabaseServices } from './supabase';
import type { Env } from '../types/env';
import type { InboxAnalysisLease, InboxAnalysisQueueJob } from '../types/inbox-analysis';
import { AiConsentRequiredError } from './supabase/ai-consent.service';
import { suggestForwardedEmail } from '../ai/forwarded-email-suggestion';
import { extractEmailEventEvidence } from '../utils/email-event-evidence';
import {
  buildDeterministicInboxAnalysisProposal,
  buildInboxAnalysisProposal,
  buildPartialInboxHistoryProposal,
  inboxHistoryCutoff
} from '../utils/inbox-analysis-proposal';

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
    const evidence = extractEmailEventEvidence(item.raw_text);
    const [categories, accounts, rules] = await Promise.all([
      services.categories.getCategories(lease.user_id),
      services.accounts.getAccounts(lease.user_id),
      services.automationRules.getAutomationRules(lease.user_id)
    ]);
    const deterministic = buildDeterministicInboxAnalysisProposal(
      item,
      accounts,
      categories,
      rules,
      services.automationRules
    );
    if (deterministic) {
      await services.inboxAnalysis.complete(lease, deterministic);
      return;
    }
    const historyCutoff = inboxHistoryCutoff(item);
    const completeEvidence =
      !evidence.ambiguous &&
      evidence.merchant &&
      evidence.type &&
      evidence.date &&
      evidence.time &&
      evidence.amount &&
      evidence.sourceLastFour;
    const [contact, exactHistory] = await Promise.all([
      !evidence.ambiguous && evidence.type && historyCutoff
        ? services.categoryReviewContext
            .verifiedContactHistory(lease.user_id, item.raw_text, evidence.type, historyCutoff)
            .catch(() => ({ contactId: null, rows: [], ambiguous: true }))
        : Promise.resolve(null),
      !evidence.ambiguous && evidence.merchant && evidence.type && historyCutoff
        ? services.categoryReviewContext
            .exactCategoryHistory(lease.user_id, evidence.merchant, evidence.type, historyCutoff)
            .catch(() => null)
        : Promise.resolve([])
    ]);
    if (completeEvidence && exactHistory) {
      const historical = buildDeterministicInboxAnalysisProposal(
        item,
        accounts,
        categories,
        rules,
        services.automationRules,
        exactHistory,
        contact
      );
      if (historical) {
        await services.inboxAnalysis.complete(lease, historical);
        return;
      }
    }
    if (historyCutoff && exactHistory) {
      const partial = buildPartialInboxHistoryProposal(
        item,
        accounts,
        categories,
        rules,
        services.automationRules,
        historyCutoff,
        exactHistory,
        contact
      );
      if (partial) {
        await services.inboxAnalysis.complete(lease, partial);
        return;
      }
    }
    await services.aiConsent.require(lease.user_id, scope);
    const lexicalHistory = await services.categoryReviewContext.history(
      lease.user_id,
      evidence.merchant ?? item.raw_text,
      evidence.type ?? ''
    );
    const contactRows =
      contact && !contact.ambiguous
        ? contact.rows
            .filter(
              (row) =>
                row.user_id === lease.user_id &&
                row.contact_id === contact.contactId &&
                row.type === evidence.type &&
                row.date <= (historyCutoff ?? '') &&
                Date.parse(historyCutoff ?? '') - Date.parse(row.date) <= 180 * 86400000
            )
            .flatMap((row) => {
              const category = categories.find(
                (category) =>
                  category.user_id === lease.user_id &&
                  category.is_active &&
                  category.type === row.type &&
                  category.id === row.category_id &&
                  !['uncategorized', 'uncategorized-income', 'missing'].includes(category.slug)
              );
              return category
                ? [
                    {
                      id: row.id,
                      description: row.description.slice(0, 500),
                      notes: row.notes ?? null,
                      category: category.name.slice(0, 150)
                    }
                  ]
                : [];
            })
        : [];
    const mergedHistory = new Map<string, (typeof lexicalHistory)[number]>();
    for (const row of [...contactRows, ...lexicalHistory])
      if (!mergedHistory.has(row.id)) mergedHistory.set(row.id, row);
    const history = [...mergedHistory.values()].slice(0, 12);
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
