import { createSupabaseServices } from '../services/supabase';
import { Env } from '../types/env';
import { resolveUserId, unauthorizedResponse } from '../utils/auth';
import { emailFingerprint, parseForwardedEmail } from '../utils/email-mime';
import { triageForwardedEmail } from '../ai/email-triage';

type IncomingEmail = Pick<ForwardableEmailMessage, 'from' | 'to' | 'raw' | 'rawSize' | 'setReject'>;
const MAX_MIME_BYTES = 512 * 1024;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

function validDomain(value: string | undefined): value is string {
  return Boolean(value && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(value));
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
  if (
    !validDomain(env.EMAIL_FORWARDING_DOMAIN) ||
    !recipient.endsWith(`@${env.EMAIL_FORWARDING_DOMAIN}`) ||
    message.rawSize > MAX_MIME_BYTES
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
  if (raw.byteLength > MAX_MIME_BYTES) {
    message.setReject('Message too large');
    return;
  }
  const parsed = await parseForwardedEmail(raw);
  if (!parsed.text) {
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
    parsed,
    env.OPENROUTER_API_KEY,
    env.OPENROUTER_TEXT_MODEL ?? 'deepseek/deepseek-v4.1-flash',
    route.user_id,
    services.aiUsage
  );
  await services.shortcutInbox.createForwardedPending({
    userId: route.user_id,
    source: 'forwarded_email',
    externalId: await emailFingerprint(parsed),
    receivedAt: new Date().toISOString(),
    rawText: triage.rawText,
    triageStatus: triage.triageStatus
  });
}
