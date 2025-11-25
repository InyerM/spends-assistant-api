# Expense Assistant Microservice

## Overview

Intelligent expense tracking system that automatically processes and categorizes transactions from multiple sources using AI, with cloud database storage and Redis caching.

## Architecture

**Platform**: Cloudflare Workers (TypeScript)  
**Database**: Supabase PostgreSQL  
**AI**: Google Gemini 2.5 Flash  
**Cache**: Redis (optional)  
**Timezone**: America/Bogota

## How It Works

### 1. Input Sources

The microservice accepts expenses from three channels:

- **Telegram Bot** (`/telegram`): Manual messages or forwarded bank SMS
- **Email** (`/email`): Gmail forwarded Bancolombia notifications
- **API** (`/transaction`): Direct transaction creation (iOS Shortcut, etc.)

### 2. Processing Flow

```
1. Message arrives → Handler receives text
2. Check Redis cache for duplicate message
3. If not cached: Send to Gemini AI for parsing
4. Gemini extracts: amount, description, category, bank, payment method
5. Lookup account and category in database
6. Apply automation rules (e.g., detect transfers)
7. Save transaction to Supabase
8. Cache parsed result (24h TTL)
9. Send confirmation
```

### 3. AI Parsing (Gemini)

Handles multiple input formats:
- **Bank SMS**: "Bancolombia: Compraste $11.000 en DLO*GOOGLE con tu T.Deb *7799, el 23/11/2024 a las 21:02"
- **Manual**: "20k en almuerzo" or "bought 50k groceries"
- **Nequi**: "Nequi: Pagaste $50.000 en UBER"

Extracts:
- Amount, description, category
- Bank, payment type (debit/credit/cash), source
- Original date/time (if present in SMS)
- Card last 4 digits (for multi-card accounts)
- Confidence score (0-100)

### 4. Database Schema

**Main Tables**:
- `accounts`: Bank accounts (Bancolombia, Nequi, Cash)
- `categories`: Expense/income categories
- `transactions`: All financial transactions
- `automation_rules`: Auto-categorization & transfer detection

### 5. Smart Features

**Automation Rules**:
- Auto-detect transfers between accounts
- Auto-categorize by keywords/patterns
- Link related transactions

**Redis Caching**:
- Stores parsed Gemini responses (24h)
- Prevents duplicate API calls for same message
- SHA-256 hash of message text as key
- Fail-open: works without Redis

**Multi-Card Support**:
- Matches transactions to specific card by last 4 digits
- Falls back to default account if not found

## Services Architecture

```
src/services/
├── supabase/
│   ├── accounts.service.ts      # Account lookups
│   ├── categories.service.ts    # Category lookups
│   ├── transactions.service.ts  # Transaction CRUD
│   ├── automation-rules.service.ts  # Business logic
│   └── index.ts                 # Factory pattern
└── cache.service.ts             # Redis caching
```

## Key Flows

### Telegram Flow
```
User sends "20k almuerzo"
↓
Telegram handler receives update
↓
CacheService checks if message processed before
↓
Gemini parses: {amount: 20000, category: "food", ...}
↓
AccountsService finds "cash" account
↓
CategoriesService finds "food" category
↓
AutomationRulesService applies rules
↓
TransactionsService saves to database
↓
CacheService stores result
↓
Bot sends confirmation message
```

### Email Flow
```
Gmail forwards Bancolombia email
↓
Apps Script extracts text → POST /email
↓
Email handler validates "Bancolombia" keyword
↓
Extract clean transaction text
↓
Same AI parsing + DB flow
↓
Return JSON response
```

## Environment Variables

**Required**:
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- `GEMINI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `API_KEY`

**Optional**:
- `REDIS_URL`, `REDIS_PASSWORD`
- `APP_URL`

## Data Models

**Transaction**:
```typescript
{
  date: "2024-11-23",
  time: "21:02:00",
  amount: 11000,
  description: "DLO*GOOGLE Google On",
  category_id: "uuid",
  account_id: "uuid",
  type: "expense",
  payment_method: "debit",
  source: "bancolombia_email",
  confidence: 100
}
```

## Performance

- **First request**: ~6s (Gemini API call)
- **Cached request**: ~50ms (Redis hit)
- **Database**: ~100ms (Supabase query)

## Development

```bash
pnpm install
pnpm dev              # Local development
pnpm type-check       # TypeScript validation
pnpm lint             # ESLint
pnpm supabase:start   # Local DB (optional)
```

## Deployment

**Platform**: Cloudflare Workers  
**Database**: Supabase Cloud  
**Cache**: Redis Cloud (Upstash, Railway, etc.)
