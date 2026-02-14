# Subscription Plans

## Overview

Spends Assistant uses a freemium model with two tiers: **Free** and **Pro**. The Free plan provides essential functionality with usage limits. The Pro plan removes all limits and adds advanced features.

## Plan Comparison

| Feature | Free | Pro |
|---------|------|-----|
| AI Parses | 15/month | Unlimited |
| Transactions | 50/month | Unlimited |
| Accounts | 4 | Unlimited |
| Automation rules | 5 | Unlimited |
| Categories | 15 | Unlimited |
| Data export (CSV, PDF) | - | Yes |
| Advanced analytics | - | Yes |
| Priority support | - | Yes |
| Custom dashboard | - | Coming soon |
| Receipt scanning | - | Coming soon |
| Multi-currency | - | Coming soon |

## Free Plan

**Price:** $0/month

### Included
- Transaction management (manual + AI parse)
- Account & category management (within limits)
- Automation rules (within limits)
- Telegram & email integrations
- Basic dashboard

### Limits
All limits are stored in the `app_settings` table and can be changed dynamically.

| Resource | Default Limit | Enforcement |
|----------|---------------|-------------|
| AI Parses | 15/month | Hard (HTTP 429) |
| Transactions | 50/month | Soft (tracked, not blocked) |
| Accounts | 4 total | Hard (HTTP 403 on create) |
| Automation rules | 5 total | Soft (tracked) |
| Categories | 15 total | Soft (tracked) |

### Limit Behavior
- **AI Parses**: When exhausted, the parse endpoint returns HTTP 429 with `PARSE_LIMIT_REACHED`. The UI falls back to manual transaction entry.
- **Accounts**: When limit reached, account creation returns HTTP 403. UI should show upgrade CTA.
- **Transactions/Automations/Categories**: Tracked for display purposes. Soft limits for now — users can exceed them but see upgrade prompts.
- Monthly limits reset automatically on the 1st of each month (new usage record is created per month).

## Pro Plan

**Price:** TBD (Coming Soon)

### Included
Everything in Free, plus:
- Unlimited AI parses
- Unlimited transactions
- Unlimited accounts
- Unlimited automation rules
- Unlimited categories
- Data export (CSV, PDF)
- Advanced analytics
- Priority support

### Subscription Details
- `status`: active | canceled | past_due
- `current_period_start` / `current_period_end`: billing cycle dates
- Auto-created on signup via database trigger (defaults to `free`)

## Technical Implementation

### Database Tables

**`app_settings`**
- Key-value configuration store for dynamic limits
- Readable by authenticated users, writable by service role only
- Seeded with default free plan limits

**`subscriptions`**
- One row per user (UNIQUE on `user_id`)
- Auto-created on signup via `handle_new_user_subscription()` trigger
- Fields: `plan`, `status`, `current_period_start`, `current_period_end`

**`usage_tracking`**
- Monthly counters per user (UNIQUE on `user_id, month`)
- Month format: `YYYY-MM`
- Self-resets: new record created automatically for each new month
- Old records (>12 months) cleaned up by monthly cron

### API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/settings/app` | Dynamic app settings (limits) |
| `GET /api/settings/subscription` | Current plan + status |
| `GET /api/settings/usage` | Current month usage counters |
| `POST /api/accounts` | Enforces account limit for free plan |
| `Worker: POST /parse` | Checks AI parse limit before processing |

### Usage Tracking Flow

1. **AI Parses**: Worker's `UsageService.incrementAiParses()` checks limit before Gemini call
2. **Transactions**: Frontend `POST /api/transactions` increments `transactions_count` after insert
3. **Accounts**: Frontend `POST /api/accounts` checks count against `free_accounts_limit`
4. **Monthly Reset**: `getOrCreateMonthlyUsage()` creates fresh record for each new month
5. **Cleanup**: Cron job runs on 1st of each month, deletes records older than 12 months

## Roadmap

- [ ] Payment gateway integration (Stripe)
- [ ] Pro plan activation/cancellation flow
- [ ] Hard transaction limit enforcement for free tier
- [ ] Hard automation rules limit enforcement
- [ ] Hard categories limit enforcement
- [ ] Usage alerts (80%, 100% of limits)
- [ ] Annual billing option
- [ ] Receipt scanning (OCR)
- [ ] Multi-currency support
- [ ] Custom dashboard widgets
- [ ] Team/family plans
