import type { InboxAnalysisQueueJob } from './inbox-analysis';
import type { ForwardedEmailJob } from './forwarded-email-job';

export interface Env {
  // Supabase
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;

  // OpenRouter AI
  OPENROUTER_API_KEY: string;
  OPENROUTER_TEXT_MODEL?: string;

  // Telegram
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_OWNER_CHAT_ID?: string;
  TELEGRAM_OWNER_USER_ID?: string;
  TELEGRAM_WEBHOOK_URL?: string;

  // API Authentication
  API_KEY: string;

  // Default user for Telegram/Email (until per-user mapping is implemented)
  DEFAULT_USER_ID: string;

  // Domain routed by Cloudflare Email Routing to this Worker.
  EMAIL_FORWARDING_DOMAIN?: string;
  EMAIL_FORWARDING_LEGACY_DOMAINS?: string;
  EMAIL_FORWARDING_READY?: string;
  EMAIL_AUTO_POST_READY?: string;
  EMAIL_PDF_INTAKE_READY?: string;
  EMAIL_AUTO_POST_AFTER?: string;
  CLOUDFLARE_ANALYTICS_TOKEN?: string;
  CLOUDFLARE_EMAIL_ZONE_ID?: string;
  EMAIL_AUTH_QUEUE?: Queue<ForwardedEmailJob | InboxAnalysisQueueJob>;

  // Optional
  APP_URL?: string;
  REDIS_URL?: string;
  REDIS_PASSWORD?: string;
}
