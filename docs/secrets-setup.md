# Secrets setup (production)

Run these commands in your terminal to configure sensitive variables in Cloudflare.
You will be prompted for each value.

```bash
# Telegram
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_BOT_USERNAME
npx wrangler secret put YOUR_CHAT_ID

# OpenRouter
npx wrangler secret put OPENROUTER_API_KEY

# API and database
npx wrangler secret put API_KEY
npx wrangler secret put SUPABASE_SERVICE_KEY

# Legacy Google Sheets integration, if deployed
npx wrangler secret put GOOGLE_SHEET_ID
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
npx wrangler secret put GOOGLE_CREDENTIALS_JSON
```

> **Note:** For `GOOGLE_CREDENTIALS_JSON`, paste the minified service-account JSON (one line), or its base64 representation if that is how your deployment handles it.

---

# Local setup (.dev.vars)

For local development (`npm run dev`), create a `.dev.vars` file in the project root with this format:

```ini
TELEGRAM_BOT_TOKEN=your_token
TELEGRAM_BOT_USERNAME=your_username
YOUR_CHAT_ID=your_chat_id
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_TEXT_MODEL=deepseek/deepseek-v4.1-flash
API_KEY=your_api_key
SUPABASE_URL=http://localhost:54321
SUPABASE_SERVICE_KEY=your_service_key
```
