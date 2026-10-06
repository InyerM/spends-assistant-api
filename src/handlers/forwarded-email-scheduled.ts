import { createSupabaseServices } from '../services/supabase';
import type { Env } from '../types/env';
import { emailFingerprint } from '../utils/email-mime';
import { extractForwardedPurchase } from '../ai/forwarded-purchase';
import { classifyForwardedPurchase } from '../ai/forwarded-purchase-category';
import type { ForwardedEmailJob } from '../types/forwarded-email-job';

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

function activationCutoff(env: Env): number | null {
  const cutoff = Date.parse(env.EMAIL_AUTO_POST_AFTER ?? '');
  return env.EMAIL_AUTO_POST_READY === 'true' &&
    env.CLOUDFLARE_ANALYTICS_TOKEN &&
    env.CLOUDFLARE_EMAIL_ZONE_ID &&
    Number.isFinite(cutoff)
    ? cutoff
    : null;
}

async function routingEvents(
  env: Env,
  since: string,
  until: string,
  exact?: { to: string; messageId?: string }
): Promise<RoutingEvent[] | null> {
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
          datetime_leq: until,
          ...(exact ? { to: exact.to } : {}),
          ...(exact?.messageId ? { messageId: exact.messageId } : {})
        }
      }
    })
  });
  if (!response.ok) return null;
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
    return null;
  return zones[0].emailRoutingAdaptive.slice(0, 100);
}

async function scheduledRoutingEvents(
  env: Env,
  since: string,
  until: string,
  depth = 0
): Promise<RoutingEvent[] | null> {
  const events = await routingEvents(env, since, until);
  if (!events || events.length < 100) return events;
  const start = Date.parse(since);
  const end = Date.parse(until);
  if (depth >= 6 || end - start <= 1_000) return null;
  const midpoint = new Date(Math.floor((start + end) / 2)).toISOString();
  const left = await scheduledRoutingEvents(env, since, midpoint, depth + 1);
  if (!left) return null;
  const right = await scheduledRoutingEvents(env, midpoint, until, depth + 1);
  if (!right) return null;
  return [
    ...new Map(
      [...left, ...right].map((event) => [
        `${event.datetime}|${event.messageId}|${event.to}`,
        event
      ])
    ).values()
  ];
}

async function postAuthenticatedEvent(
  event: RoutingEvent,
  env: Env,
  cutoff: number,
  now: Date,
  minimumAgeMs: number,
  retryProviderFailures = false
): Promise<boolean | undefined> {
  const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
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
    received < cutoff ||
    received > now.getTime() - minimumAgeMs ||
    received <= now.getTime() - 40 * 60_000 ||
    typeof event.to !== 'string'
  )
    return;
  try {
    const route = await services.forwardingRoutes.getByAddress(event.to);
    if (
      !route ||
      route.address !== event.to ||
      !route.confirmation_received_at ||
      !route.user_confirmed_at
    )
      return;
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
      return;
    const prefix = `From (unverified): ${sender}\n\n${event.subject}\n\n`;
    if (!inbox.raw_text.startsWith(prefix) || inbox.raw_text.includes('[Content truncated]'))
      return;
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
    if (!purchase) return;
    const accounts = await services.accounts.getAccounts(route.user_id);
    const matches = accounts.filter(
      (account) =>
        account.institution?.toLowerCase().includes('lulo') &&
        account.type === 'credit_card' &&
        account.last_four === purchase.cardLastFour &&
        account.currency === 'COP' &&
        account.is_active
    );
    if (matches.length !== 1) return;
    const categories = await services.categories.getCategories(route.user_id);
    const model = env.OPENROUTER_TEXT_MODEL ?? 'deepseek/deepseek-v4.1-flash';
    const classification = await classifyForwardedPurchase(
      purchase.merchant,
      categories,
      env.OPENROUTER_API_KEY,
      model,
      route.user_id,
      services.aiUsage,
      retryProviderFailures
    );
    if (!classification) return;
    await services.forwardedEmailAutoPost.post({
      userId: route.user_id,
      inboxItemId: inbox.id,
      accountId: matches[0].id,
      categoryId: classification.categoryId,
      amount: purchase.amount,
      date: purchase.date,
      time: purchase.time,
      cardLastFour: purchase.cardLastFour,
      description: `Compra en ${purchase.merchant}`,
      model: classification.model
    });
  } catch {
    console.error('[Email auto-post] Candidate processing failed');
    return false;
  }
}

export async function handleScheduledForwardedEmails(env: Env, now = new Date()): Promise<void> {
  const cutoff = activationCutoff(env);
  if (cutoff === null || cutoff > now.getTime() - 10 * 60_000) return;
  const since = new Date(Math.max(cutoff, now.getTime() - 40 * 60_000)).toISOString();
  const events = await scheduledRoutingEvents(
    env,
    since,
    new Date(now.getTime() - 10 * 60_000).toISOString()
  );
  if (!events) return;
  for (const event of events) {
    await postAuthenticatedEvent(event, env, cutoff, now, 10 * 60_000);
  }
}

export async function handleQueuedForwardedEmail(
  job: ForwardedEmailJob,
  env: Env,
  now = new Date(),
  attempt = 1
): Promise<'done' | 'retry'> {
  const cutoff = activationCutoff(env);
  const receivedAt = Date.parse(job.receivedAt);
  if (
    cutoff === null ||
    !/^[a-f0-9]{64}$/u.test(job.externalId) ||
    typeof job.recipient !== 'string' ||
    !env.EMAIL_FORWARDING_DOMAIN ||
    !job.recipient.endsWith(`@${env.EMAIL_FORWARDING_DOMAIN}`) ||
    !Number.isFinite(receivedAt) ||
    receivedAt < cutoff ||
    receivedAt > now.getTime() ||
    receivedAt <= now.getTime() - 40 * 60_000
  )
    return 'done';

  if (job.messageId !== undefined) {
    if (
      typeof job.messageId !== 'string' ||
      !job.messageId ||
      job.messageId.length > 256 ||
      job.messageId.trim() !== job.messageId ||
      (await emailFingerprint({
        messageId: job.messageId,
        sender: null,
        subject: '',
        text: '',
        date: ''
      })) !== job.externalId
    )
      return 'done';
  }

  const since = new Date(Math.max(cutoff, receivedAt - 5 * 60_000)).toISOString();
  const until = new Date(Math.min(now.getTime(), receivedAt + 5 * 60_000)).toISOString();
  let events: RoutingEvent[] | null;
  try {
    events = await routingEvents(env, since, until, {
      to: job.recipient,
      messageId: job.messageId
    });
  } catch {
    return 'retry';
  }
  if (!events) return 'retry';
  const matching: RoutingEvent[] = [];
  for (const event of events) {
    if (
      event.to !== job.recipient ||
      !event.messageId ||
      !Number.isFinite(Date.parse(event.datetime)) ||
      Math.abs(Date.parse(event.datetime) - receivedAt) > 5 * 60_000
    )
      continue;
    const externalId = await emailFingerprint({
      messageId: event.messageId,
      sender: null,
      subject: '',
      text: '',
      date: ''
    });
    if (externalId === job.externalId) matching.push(event);
  }
  if (matching.length === 0) return 'retry';
  if (matching.length !== 1) return 'done';
  const processed = await postAuthenticatedEvent(matching[0], env, cutoff, now, 0, true);
  return processed === false && attempt <= 3 ? 'retry' : 'done';
}
