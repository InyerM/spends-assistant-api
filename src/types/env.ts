export interface Env {
  // Supabase
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  
  // Gemini AI
  GEMINI_API_KEY: string;
  
  // Telegram
  TELEGRAM_BOT_TOKEN: string;
  
  // API Authentication
  API_KEY: string;
  
  // Optional
  APP_URL?: string;
  REDIS_URL?: string;
  REDIS_PASSWORD?: string;
}
