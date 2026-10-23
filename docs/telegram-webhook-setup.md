# Telegram webhook setup

The bot is bound to one private Telegram chat and sender, mapped to the existing server-owned `DEFAULT_USER_ID`. This endpoint does not enroll arbitrary Telegram users.

## Configure the owner binding

Configure these values through Wrangler's interactive prompts. Never put actual values in command arguments, source files, screenshots, or logs.

```bash
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET
pnpm exec wrangler secret put TELEGRAM_OWNER_CHAT_ID
pnpm exec wrangler secret put TELEGRAM_OWNER_USER_ID
pnpm exec wrangler secret put TELEGRAM_WEBHOOK_URL
```

- `TELEGRAM_WEBHOOK_SECRET`: a random 32–256 character string containing only ASCII letters, digits, `_`, or `-`. The 32 character minimum is this application's policy; Telegram permits 1–256 characters.
- `TELEGRAM_OWNER_CHAT_ID` and `TELEGRAM_OWNER_USER_ID`: the registered private chat and sender IDs as canonical positive decimal strings, no leading zeros, signs, whitespace, decimal points, or exponents. Values must fit Telegram's 52 significant bit ID bound.
- `TELEGRAM_WEBHOOK_URL`: the server-configured canonical HTTPS URL ending exactly in `/telegram`, without credentials, an explicit port, query, or fragment. Request hosts and request bodies never select the webhook destination.
- `DEFAULT_USER_ID`: the existing server configuration identifying the application owner. Incoming updates cannot override this binding.

Missing or invalid owner/secret/token configuration makes `/telegram` return 503 before parsing or downstream services. Configure and register the authenticated webhook when releasing this change; an old registration without the secret header will be refused.

## Register through the authenticated setup endpoint

Send `POST /setup-webhook` with the application owner's interactive Supabase session JWT. Static API keys and delegated API keys are not accepted as interactive authentication; a different authenticated owner receives 403.

For example, from an existing trusted administrative client with an active session:

```typescript
const response = await fetch(`${trustedWorkerOrigin}/setup-webhook`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${session.access_token}` }
});
```

The server sends a POST JSON request to Telegram's `setWebhook` with the configured URL, `secret_token`, and `allowed_updates: ['message']`. The response exposes only registration status and the configured public URL; it does not return the bot token, secret, or Telegram's raw response. Registration failures use a generic error.

## Inbound enforcement

The Worker compares `X-Telegram-Bot-Api-Secret-Token` with fixed-size buffers and a constant-time comparison before reading JSON or creating bot/database/cache services. JSON is limited to 64 KiB of actual streamed bytes, including when `Content-Length` is missing or dishonest.

Only an ordinary text `message` update from the exact registered non-bot sender in the exact registered private chat is accepted. Text is limited to 4096 Unicode code points. Edited messages, callbacks, channel/business updates, mixed update types, and unsupported messages are refused before financial processing or replies.

Run the local mocked regression tests:

```bash
pnpm exec vitest run tests/handlers/telegram-security.test.ts tests/handlers/telegram-brand.test.ts
```

These tests make no real Telegram requests. Do not log update bodies, secret headers, bot tokens, or private Telegram identifiers. Deployment, production registration, and sending test messages are separate operator actions requiring authorization; this patch does not perform them.

## Primary references

- [Telegram Bot API: setWebhook and secret_token](https://core.telegram.org/bots/api#setwebhook)
- [Telegram Bot API: User and Chat identifiers](https://core.telegram.org/bots/api#user)
- [Cloudflare Workers: Node.js crypto compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)
