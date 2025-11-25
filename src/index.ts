import { handleTelegram } from './handlers/telegram';
import { handleEmail } from './handlers/email';
import { handleTransaction } from './handlers/transaction';
import { handleBalance } from './handlers/balance';
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

    // Transaction API
    if (url.pathname === '/transaction' && request.method === 'POST') {
      return handleTransaction(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // Cron jobs here
  }
};
