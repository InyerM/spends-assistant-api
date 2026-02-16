import { handleTelegram } from './handlers/telegram';
import { handleEmail } from './handlers/email';
import { handleTransaction } from './handlers/transaction';
import { handleParse } from './handlers/parse';
import { handleBalance } from './handlers/balance';
import { handleAutomationGenerate } from './handlers/automation-generate';
import { createSupabaseServices } from './services/supabase';
import { Env } from './types/env';

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'expense-assistant',
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Setup webhook helper
    if (url.pathname === '/setup-webhook' && request.method === 'GET') {
      const webhookUrl = `${url.origin}/telegram`;
      const telegramApiUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;
      
      return new Response(JSON.stringify({
        message: 'To setup Telegram webhook, visit this URL in your browser:',
        url: telegramApiUrl,
        webhook: webhookUrl
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
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

    // Parse API (parse only, no save)
    if (url.pathname === '/parse' && request.method === 'POST') {
      return handleParse(request, env);
    }

    // Transaction API
    if (url.pathname === '/transaction' && request.method === 'POST') {
      return handleTransaction(request, env);
    }

    // Automation rule generation (AI preview, no save)
    if (url.pathname === '/automation/generate' && request.method === 'POST') {
      return handleAutomationGenerate(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
    await services.usage.cleanupOldRecords();
  }
};
