import { createSupabaseServices } from '../services/supabase';
import { Env } from '../types/env';
import { resolveUserId, unauthorizedResponse } from '../utils/auth';
import { emailFingerprint, inboxText, parseForwardedEmail } from '../utils/email-mime';

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
        verification_text: route.verification_text
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
          verification_text: route.verification_text
        },
        201
      );
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
    /gmail forwarding confirmation/iu.test(parsed.subject)
  ) {
    await services.forwardingRoutes.recordConfirmation(
      route.user_id,
      recipient,
      parsed.text.slice(0, 2048)
    );
    return;
  }

  await services.shortcutInbox.createForwardedPending({
    userId: route.user_id,
    source: 'forwarded_email',
    externalId: await emailFingerprint(parsed),
    receivedAt: new Date().toISOString(),
    rawText: inboxText(parsed)
  });
}
