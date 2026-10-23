# Secrets setup (production)

Run these commands in your terminal to configure sensitive variables in Cloudflare.
You will be prompted for each value.

```bash
# Telegram
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET
pnpm exec wrangler secret put TELEGRAM_OWNER_CHAT_ID
pnpm exec wrangler secret put TELEGRAM_OWNER_USER_ID
pnpm exec wrangler secret put TELEGRAM_WEBHOOK_URL

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

Telegram requires every listed Telegram variable and the existing server-owned `DEFAULT_USER_ID` binding. Use canonical positive decimal owner IDs and a random 32–256 character URL-safe webhook secret. `TELEGRAM_WEBHOOK_URL` is the trusted HTTPS Worker URL ending exactly in `/telegram`. Missing configuration disables Telegram processing. Follow [the owner-only registration procedure](telegram-webhook-setup.md); do not pass secret values in command arguments or commit them.

---

# Local setup (.dev.vars)

For local development (`npm run dev`), create a `.dev.vars` file in the project root with this format:

```ini
TELEGRAM_BOT_TOKEN=your_token
TELEGRAM_WEBHOOK_SECRET=replace_with_a_random_32_to_256_character_url_safe_secret
TELEGRAM_OWNER_CHAT_ID=your_positive_decimal_private_chat_id
TELEGRAM_OWNER_USER_ID=your_positive_decimal_telegram_user_id
TELEGRAM_WEBHOOK_URL=https://your-worker.example/telegram
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_TEXT_MODEL=deepseek/deepseek-v4.1-flash
API_KEY=your_api_key
SUPABASE_URL=http://localhost:54321
SUPABASE_SERVICE_KEY=your_service_key
```
