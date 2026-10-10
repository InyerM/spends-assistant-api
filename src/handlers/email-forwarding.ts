import { createSupabaseServices } from '../services/supabase';
import { Env } from '../types/env';
import { resolveUserId, unauthorizedResponse } from '../utils/auth';
import { emailFingerprint, parseForwardedEmail } from '../utils/email-mime';
import { triageForwardedEmail } from '../ai/email-triage';
import { extractForwardedPurchase } from '../ai/forwarded-purchase';

type IncomingEmail = Pick<ForwardableEmailMessage, 'from' | 'to' | 'raw' | 'rawSize' | 'setReject'>;
const MAX_MIME_BYTES = 512 * 1024;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

function validDomain(value: string | undefined): value is string {
  return Boolean(
    value &&
      value.length <= 253 &&
      value.split('.').length >= 2 &&
      value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
  );
}

export async function handleEmailForwardingRoute(request: Request, env: Env): Promise<Response> {
  const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const userId = await resolveUserId(request, env, services.apiKeys);
  if (!userId) return unauthorizedResponse();

  try {
    if (request.method === 'GET') {
      const route = await services.forwardingRoutes.getForUser(userId);
      if (!route)
        return json({
          status:
            env.EMAIL_FORWARDING_READY === 'true' && validDomain(env.EMAIL_FORWARDING_DOMAIN)
              ? 'unconfigured'
              : 'unavailable'
        });
      return json({
        status: 'active',
        address: route.address,
        created_at: route.created_at,
        confirmation_received_at: route.confirmation_received_at,
        verification_text: route.verification_text,
        user_confirmed_at: route.user_confirmed_at
      });
    }
    if (request.method === 'POST') {
      if (env.EMAIL_FORWARDING_READY !== 'true' || !validDomain(env.EMAIL_FORWARDING_DOMAIN))
        return json({ error: 'Email routing unavailable' }, 503);
      const route = await services.forwardingRoutes.createForUser(
        userId,
        env.EMAIL_FORWARDING_DOMAIN
      );
      return json(
        {
          status: 'active',
          address: route.address,
          created_at: route.created_at,
          confirmation_received_at: route.confirmation_received_at,
          verification_text: route.verification_text,
          user_confirmed_at: route.user_confirmed_at
        },
        201
      );
    }
    if (request.method === 'PATCH') {
      const confirmed = await services.forwardingRoutes.acknowledgeVerification(userId);
      if (!confirmed) return json({ error: 'Gmail confirmation message has not arrived' }, 409);
      return json({
        status: 'active',
        address: confirmed.address,
        created_at: confirmed.created_at,
        confirmation_received_at: confirmed.confirmation_received_at,
        verification_text: confirmed.verification_text,
        user_confirmed_at: confirmed.user_confirmed_at
      });
    }
    if (request.method === 'DELETE') {
      await services.forwardingRoutes.deleteForUser(userId);
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } });
    }
    return json({ error: 'Method not allowed' }, 405);
  } catch {
    return json({ error: 'Email forwarding route failed' }, 500);
  }
}

export async function handleForwardedEmail(message: IncomingEmail, env: Env): Promise<void> {
  const recipient = message.to.toLowerCase();
  const allowedDomains = [
    env.EMAIL_FORWARDING_DOMAIN,
    ...(env.EMAIL_FORWARDING_LEGACY_DOMAINS ?? '')
      .split(',')
      .map((domain) => domain.trim().toLowerCase())
  ].filter(validDomain);
  const maxMimeBytes = env.EMAIL_PDF_INTAKE_READY === 'true' ? 8 * 1024 * 1024 : MAX_MIME_BYTES;
  if (
    !validDomain(env.EMAIL_FORWARDING_DOMAIN) ||
    !allowedDomains.some((domain) => recipient.endsWith(`@${domain}`)) ||
    message.rawSize > maxMimeBytes
  ) {
    message.setReject('Invalid forwarding destination or message size');
    return;
  }

  const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const route = await services.forwardingRoutes.getByAddress(recipient);
  if (!route || route.address !== recipient) {
    message.setReject('Unknown forwarding destination');
    return;
  }

  const raw = await new Response(message.raw).arrayBuffer();
  if (raw.byteLength > maxMimeBytes) {
    message.setReject('Message too large');
    return;
  }
  let parsed;
  try {
    parsed = await parseForwardedEmail(raw);
  } catch {
    message.setReject('Invalid MIME or PDF attachment limits exceeded');
    return;
  }
  const pdfAttachments = parsed.pdfAttachments ?? [];
  const hasPdf = pdfAttachments.length > 0;
  if (
    hasPdf &&
    (env.EMAIL_PDF_INTAKE_READY !== 'true' ||
      !route.confirmation_received_at ||
      !route.user_confirmed_at)
  ) {
    message.setReject('PDF intake requires verified forwarding');
    return;
  }
  if (!parsed.text && !hasPdf) {
    message.setReject('Message has no readable text');
    return;
  }

  if (
    message.from.toLowerCase() === 'forwarding-noreply@google.com' &&
    /gmail (?:forwarding confirmation|confirmaci[o\u00f3]n de reenv[i\u00ed]o)/iu.test(
      parsed.subject
    )
  ) {
    await services.forwardingRoutes.recordConfirmation(
      route.user_id,
      recipient,
      parsed.text.slice(0, 2048)
    );
    return;
  }

  const triage = await triageForwardedEmail(
    hasPdf
      ? { ...parsed, text: 'PDF attachment received. Review the private document before posting.' }
      : parsed,
    env.OPENROUTER_API_KEY,
    env.OPENROUTER_TEXT_MODEL ?? 'deepseek/deepseek-v4.1-flash',
    route.user_id,
    services.aiUsage,
    !hasPdf && !!route.confirmation_received_at && !!route.user_confirmed_at
  );
  if (hasPdf) {
    triage.triageStatus = 'pending';
    if (!['statement', 'financial_document'].includes(triage.messageKind))
      triage.messageKind = 'uncertain';
  }
  const receivedAt = new Date().toISOString();
  const externalId = await emailFingerprint(parsed);
  const write = await services.shortcutInbox.createForwardedPending({
    userId: route.user_id,
    source: 'forwarded_email',
    externalId,
    receivedAt,
    rawText: triage.rawText,
    triageStatus: triage.triageStatus,
    messageKind: triage.messageKind,
    messageKindSource: triage.messageKindSource
  });
  if (hasPdf) {
    for (const attachment of pdfAttachments) {
      await services.emailAttachments.store({
        userId: route.user_id,
        inboxItemId: write.id,
        externalId,
        attachment
      });
    }
    return;
  }
  const cutoff = Date.parse(env.EMAIL_AUTO_POST_AFTER ?? '');
  if (
    !write.created ||
    write.status !== 'pending' ||
    !route.confirmation_received_at ||
    !route.user_confirmed_at ||
    env.EMAIL_AUTO_POST_READY !== 'true' ||
    !env.EMAIL_AUTH_QUEUE ||
    !Number.isFinite(cutoff) ||
    Date.parse(receivedAt) < cutoff ||
    !parsed.messageId ||
    !extractForwardedPurchase(parsed, receivedAt)
  )
    return;
  try {
    await env.EMAIL_AUTH_QUEUE.send(
      { externalId, recipient, receivedAt, messageId: parsed.messageId },
      { delaySeconds: 60 }
    );
  } catch {
    console.error('[Email auto-post] Authentication queue unavailable');
  }
}
