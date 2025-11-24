# Smart Expense Assistant

Telegram bot hosted on Cloudflare Workers that uses Gemini 2.0 Flash to parse expenses and save them to Google Sheets.

## Features
- 🧠 **AI Parsing**: Extracts data from natural language, emails, and SMS.
- 📊 **Google Sheets**: Auto-saves to a structured spreadsheet.
- ⚡ **Cloudflare Workers**: Serverless, fast, and cheap.

## Setup

### 1. Google Cloud Setup
1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project.
3. Enable **Google Sheets API**.
4. Create a **Service Account**:
   - Go to IAM & Admin > Service Accounts.
   - Create new service account.
   - Create Key > JSON. Download the file.
5. **Share your Google Sheet** with the service account email (client_email in the JSON).

### 2. Telegram Bot Setup
1. Talk to [@BotFather](https://t.me/botfather).
2. Create a new bot (`/newbot`).
3. Get the **API Token**.

### 3. Gemini API
1. Get an API key from [Google AI Studio](https://aistudio.google.com/).

### 4. Project Configuration
1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure Secrets (in Cloudflare):
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put GOOGLE_SHEET_ID
   # For GOOGLE_CREDENTIALS_JSON, encode your entire JSON file to base64 first:
   # base64 -i credentials.json | pbcopy
   npx wrangler secret put GOOGLE_CREDENTIALS_JSON
   ```

### 5. Deploy
```bash
npx wrangler deploy
```

### 6. Set Webhook
After deploying, set the Telegram webhook to your worker URL:
```bash
curl -F "url=https://your-worker-name.your-subdomain.workers.dev/telegram" https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook
```

## Usage
- Send a message: "20k lunch"
- Forward an email from Bancolombia.
- Forward an SMS from Nequi.

## Structure
- `src/index.js`: Entry point.
- `src/handlers/telegram.js`: Bot logic.
- `src/parsers/gemini.js`: AI extraction.
- `src/services/sheets.js`: Google Sheets integration.
