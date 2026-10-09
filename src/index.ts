import { handleStatementTextExtract } from './handlers/statement-text-extract';
import { handleFinancialChat } from './handlers/financial-chat';
import {
  handleQueuedForwardedEmail,
  handleScheduledForwardedEmails
} from './handlers/forwarded-email-scheduled';
import { handleTelegram } from './handlers/telegram';
import { handleEmail } from './handlers/email';
import { handleEmailForwardingRoute, handleForwardedEmail } from './handlers/email-forwarding';
import { handleTransaction } from './handlers/transaction';
import { handleParse } from './handlers/parse';
import { handleVisionExtract } from './handlers/vision-extract';
import { handleMerchantSuggest } from './handlers/merchant-suggest';
import { handleForwardedEmailSuggest } from './handlers/forwarded-email-suggest';
import { handleBalance } from './handlers/balance';
import { handleAutomationExplain } from './handlers/automation-explain';
import { handleAutomationGenerate } from './handlers/automation-generate';
import { handleAiConsent } from './handlers/ai-consent';
import { createSupabaseServices } from './services/supabase';
import { resolveUserId, unauthorizedResponse } from './utils/auth';
import { Env } from './types/env';
import type { ForwardedEmailJob } from './types/forwarded-email-job';

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'expense-assistant',
          timestamp: new Date().toISOString()
        }),
        {
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    // Setup webhook helper (protected — does not expose bot token)
    if (url.pathname === '/setup-webhook' && request.method === 'POST') {
      const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
      const userId = await resolveUserId(request, env, services.apiKeys);
      if (!userId) return unauthorizedResponse();

      const webhookUrl = `${url.origin}/telegram`;
      const telegramApiUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;

      const res = await fetch(telegramApiUrl);
      const result = await res.json();

      return new Response(
        JSON.stringify({
          status: 'ok',
          webhook: webhookUrl,
          telegram_response: result
        }),
        {
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    // Balance endpoint
    if (url.pathname.startsWith('/balance/') && request.method === 'GET') {
      return handleBalance(request, env);
    }

    // Telegram webhook
    if (url.pathname === '/telegram' && request.method === 'POST') {
      return handleTelegram(request, env);
    }

    // Email endpoint
    if (url.pathname === '/email' && request.method === 'POST') {
      return handleEmail(request, env);
    }

    if (url.pathname === '/email-forwarding-route') {
      return handleEmailForwardingRoute(request, env);
    }

    if (url.pathname === '/ai/consent') {
      return handleAiConsent(request, env);
    }

    if (url.pathname === '/financial/chat' && request.method === 'POST') {
      return handleFinancialChat(request, env);
    }

    // Parse API (parse only, no save)
    if (url.pathname === '/parse' && request.method === 'POST') {
      return handleParse(request, env);
    }

    if (url.pathname === '/documents/extract-text' && request.method === 'POST') {
      return handleStatementTextExtract(request, env);
    }
    if (url.pathname === '/vision/extract' && request.method === 'POST') {
      return handleVisionExtract(request, env);
    }

    if (url.pathname === '/merchant/suggest' && request.method === 'POST') {
      return handleMerchantSuggest(request, env);
    }

    if (url.pathname === '/forwarded-email/suggest' && request.method === 'POST') {
      return handleForwardedEmailSuggest(request, env);
    }

    // Transaction API
    if (url.pathname === '/transaction' && request.method === 'POST') {
      return handleTransaction(request, env);
    }

    // Automation rule generation (AI preview, no save)
    if (url.pathname === '/automation/explain' && request.method === 'POST') {
      return handleAutomationExplain(request, env);
    }

    if (url.pathname === '/automation/generate' && request.method === 'POST') {
      return handleAutomationGenerate(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },

  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleForwardedEmail(message, env);
  },

  async queue(
    batch: MessageBatch<ForwardedEmailJob>,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    for (const message of batch.messages) {
      try {
        const result = await handleQueuedForwardedEmail(
          message.body,
          env,
          new Date(),
          message.attempts
        );
        if (result === 'retry') message.retry({ delaySeconds: 60 });
        else message.ack();
      } catch {
        console.error('[Email auto-post] Queue processing failed');
        message.retry({ delaySeconds: 60 });
      }
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (event.cron === '0 3 1 * *') {
      const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
      await Promise.all([services.usage.cleanupOldRecords(), services.aiUsage.cleanupOldEvents()]);
    } else if (event.cron === '*/15 * * * *') {
      await handleScheduledForwardedEmails(env, new Date(event.scheduledTime));
    }
  }
};
