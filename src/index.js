import { handleTelegram } from './handlers/telegram.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Telegram Webhook
    if (request.method === 'POST' && url.pathname === '/telegram') {
      return handleTelegram(request, env);
    }

    // Email Handling (Placeholder for Email Routing or HTTP trigger)
    if (request.method === 'POST' && url.pathname === '/email') {
      // Logic for parsing forwarded emails can go here
      // For now, we can reuse the telegram handler logic or create a specific one
      return new Response('Email handler not implemented yet', { status: 501 });
    }

    // Health check
    if (url.pathname === '/') {
      return new Response('Expense Assistant Bot is running!', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  },

  // Cron Triggers
  async scheduled(event, env, ctx) {
    // Implement daily summary here
    console.log("Cron triggered");
  }
};
