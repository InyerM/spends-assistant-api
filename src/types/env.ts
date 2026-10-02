export interface Env {
  // Supabase
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;

  // OpenRouter AI
  OPENROUTER_API_KEY: string;
  OPENROUTER_TEXT_MODEL?: string;

  // Telegram
  TELEGRAM_BOT_TOKEN: string;

  // API Authentication
  API_KEY: string;

  // Default user for Telegram/Email (until per-user mapping is implemented)
  DEFAULT_USER_ID: string;

  // Domain routed by Cloudflare Email Routing to this Worker.
  EMAIL_FORWARDING_DOMAIN?: string;

  // Optional
  APP_URL?: string;
  REDIS_URL?: string;
  REDIS_PASSWORD?: string;
}
