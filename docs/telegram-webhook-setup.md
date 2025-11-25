# Telegram Bot Webhook Setup

## The Problem

Telegram bots need to know where to send messages. Without a webhook configured, Telegram doesn't know your worker URL and won't send the commands you type.

## Solution: Configure the Webhook

### Option 1: Automatic Setup (Easiest)

1. **Visit this URL in your browser:**
   ```
   https://expense-assistant.inyer-spends-assistant.workers.dev/setup-webhook
   ```

2. **Copy the webhook setup URL** from the response

3. **Paste it in your browser** and visit it

4. **You should see:** `{"ok":true,"result":true,"description":"Webhook was set"}`

### Option 2: Manual Setup

Run this command (replace `YOUR_BOT_TOKEN` with your actual token):

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://expense-assistant.inyer-spends-assistant.workers.dev/telegram"
```

### Option 3: Using Wrangler (Development)

For local testing with ngrok or similar:

```bash
# Start ngrok
ngrok http 8787

# Get the https URL (e.g., https://abc123.ngrok.io)
# Then set webhook:
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://abc123.ngrok.io/telegram"
```

## Verify Webhook is Set

Check webhook status:
```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

Should show:
```json
{
  "ok": true,
  "result": {
    "url": "https://expense-assistant.inyer-spends-assistant.workers.dev/telegram",
    "has_custom_certificate": false,
    "pending_update_count": 0
  }
}
```

## Test the Bot

1. Open Telegram
2. Find your bot
3. Send `/start`
4. Bot should respond with welcome message! 🎉

## Troubleshooting

**Bot still doesn't respond?**

1. **Check webhook is set:**
   ```bash
   curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
   ```

2. **Check worker is deployed:**
   ```
   https://expense-assistant.inyer-spends-assistant.workers.dev/health
   ```
   Should return: `{"status":"ok"}`

3. **Check worker logs:**
   ```bash
   npx wrangler tail
   ```
   Then send a message to the bot and watch for errors

4. **Delete webhook and reset:**
   ```bash
   curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/deleteWebhook"
   ```
   Then set it again

## Important Notes

- Webhook URL must be HTTPS (worker URLs are already HTTPS)
- Telegram sends a test request when you set the webhook
- Changes take ~1 minute to propagate
- Only one webhook per bot (setting new one replaces old)
