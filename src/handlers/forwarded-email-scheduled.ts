import { createSupabaseServices } from '../services/supabase';
import type { Env } from '../types/env';
import { emailFingerprint } from '../utils/email-mime';
import { extractForwardedPurchase } from '../ai/forwarded-purchase';
import { classifyForwardedPurchase } from '../ai/forwarded-purchase-category';

interface RoutingEvent {
  datetime: string;
  messageId: string;
  from: string;
  to: string;
  subject: string;
  status: string;
  action: string;
  dkim: string;
  dmarc: string;
  arc: string;
  isSpam: number;
  sampleInterval: number;
}

export async function handleScheduledForwardedEmails(env: Env, now = new Date()): Promise<void> {
  const cutoff = Date.parse(env.EMAIL_AUTO_POST_AFTER ?? '');
  if (
    env.EMAIL_AUTO_POST_READY !== 'true' ||
    !env.CLOUDFLARE_ANALYTICS_TOKEN ||
    !env.CLOUDFLARE_EMAIL_ZONE_ID ||
    !Number.isFinite(cutoff) ||
    cutoff > now.getTime()
  )
    return;
  const since = new Date(Math.max(cutoff, now.getTime() - 40 * 60_000)).toISOString();
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_ANALYTICS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query:
        'query Q($zoneTag: string, $filter: EmailRoutingAdaptiveFilter_InputObject) { viewer { zones(filter: { zoneTag: $zoneTag }) { emailRoutingAdaptive(filter: $filter, limit: 100, orderBy: [datetime_DESC]) { datetime messageId from to subject status action dkim dmarc arc isSpam sampleInterval } } } }',
      variables: {
        zoneTag: env.CLOUDFLARE_EMAIL_ZONE_ID,
        filter: {
          datetime_geq: since,
          datetime_leq: new Date(now.getTime() - 10 * 60_000).toISOString()
        }
      }
    })
  });
  if (!response.ok) return;
  const payload = (await response.json()) as {
    errors?: unknown[];
    data?: { viewer?: { zones?: { emailRoutingAdaptive?: RoutingEvent[] }[] } };
  };
  const zones = payload.data?.viewer?.zones;
  if (
    payload.errors?.length ||
    zones?.length !== 1 ||
    !Array.isArray(zones[0].emailRoutingAdaptive)
  )
    return;
  const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  for (const event of zones[0].emailRoutingAdaptive.slice(0, 100)) {
    const received = Date.parse(event.datetime);
    const sender =
      typeof event.from === 'string'
        ? event.from.match(
            /^(?:notificaciones@lulobank\.com|[^<>,]*<notificaciones@lulobank\.com>)$/iu
          )?.[0]
          ? 'notificaciones@lulobank.com'
          : null
        : null;
    if (
      !sender ||
      event.subject !== 'Compra realizada' ||
      !event.messageId ||
      event.messageId.length > 256 ||
      event.messageId.trim() !== event.messageId ||
      event.dkim !== 'pass' ||
      event.dmarc !== 'pass' ||
      event.arc !== 'pass' ||
      event.isSpam !== 0 ||
      event.sampleInterval !== 1 ||
      event.action !== 'worker' ||
      !['dropped', 'handled'].includes(event.status) ||
      !Number.isFinite(received) ||
      received < Date.parse(since) ||
      received > now.getTime() - 10 * 60_000 ||
      received <= now.getTime() - 40 * 60_000 ||
      typeof event.to !== 'string'
    )
      continue;
    try {
      const route = await services.forwardingRoutes.getByAddress(event.to);
      if (
        !route ||
        route.address !== event.to ||
        !route.confirmation_received_at ||
        !route.user_confirmed_at
      )
        continue;
      const externalId = await emailFingerprint({
        messageId: event.messageId,
        sender,
        subject: event.subject,
        text: '',
        date: ''
      });
      const inbox = await services.shortcutInbox.getPendingForwarded(
        route.user_id,
        externalId,
        new Date(cutoff).toISOString()
      );
      if (
        !inbox ||
        inbox.user_id !== route.user_id ||
        inbox.source !== 'forwarded_email' ||
        inbox.status !== 'pending' ||
        inbox.external_id !== externalId ||
        !Number.isFinite(Date.parse(inbox.received_at)) ||
        Date.parse(inbox.received_at) < cutoff ||
        Math.abs(Date.parse(inbox.received_at) - received) > 5 * 60_000
      )
        continue;
      const prefix = `From (unverified): ${sender}\n\n${event.subject}\n\n`;
      if (!inbox.raw_text.startsWith(prefix) || inbox.raw_text.includes('[Content truncated]'))
        continue;
      const purchase = extractForwardedPurchase(
        {
          sender,
          subject: event.subject,
          text: inbox.raw_text.slice(prefix.length),
          messageId: event.messageId,
          date: ''
        },
        inbox.received_at
      );
      if (!purchase) continue;
      const accounts = await services.accounts.getAccounts(route.user_id);
      const matches = accounts.filter(
        (account) =>
          account.institution?.toLowerCase().includes('lulo') &&
          account.type === 'credit_card' &&
          account.last_four === purchase.cardLastFour &&
          account.currency === 'COP' &&
          account.is_active
      );
      if (matches.length !== 1) continue;
      const categories = await services.categories.getCategories(route.user_id);
      const model = env.OPENROUTER_TEXT_MODEL ?? 'deepseek/deepseek-v4.1-flash';
      const categoryId = await classifyForwardedPurchase(
        purchase.merchant,
        categories,
        env.OPENROUTER_API_KEY,
        model,
        route.user_id,
        services.aiUsage
      );
      if (!categoryId) continue;
      await services.forwardedEmailAutoPost.post({
        userId: route.user_id,
        inboxItemId: inbox.id,
        accountId: matches[0].id,
        categoryId,
        amount: purchase.amount,
        date: purchase.date,
        time: purchase.time,
        cardLastFour: purchase.cardLastFour,
        description: `Compra en ${purchase.merchant}`,
        model
      });
    } catch {
      console.error('[Email auto-post] Candidate processing failed');
    }
  }
}
