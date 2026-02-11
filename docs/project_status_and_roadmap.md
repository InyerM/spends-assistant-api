# Spends Assistant — Project Status & Roadmap

## 1. System Overview

Spends Assistant is an AI-powered expense tracking system that automatically captures, categorizes, and stores financial transactions from multiple input channels. It uses **Google Gemini 2.5 Flash** for natural language parsing of bank notifications and manual entries.

### Architecture

```
Input Channels                     Processing Layer              Data Layer
─────────────────                  ─────────────────             ──────────
Telegram Bot ─────────┐
                      │
Bancolombia Email ────┼──→ Cloudflare Worker (TypeScript)
(via Apps Script)     │         │
                      │         ├─ Gemini AI Parser
iOS Shortcut / API ───┤         ├─ Redis Cache (fail-open)
                      │         ├─ Transfer Detection
Next.js Web App ──────┘         ├─ Automation Rules Engine
                                └─ Balance Management
                                         │
                                         ▼
                                   Supabase PostgreSQL
                                   (accounts, categories,
                                    transactions, rules)
```

### Tech Stack

| Component       | Backend (Worker)              | Frontend (Web)                  |
| --------------- | ----------------------------- | ------------------------------- |
| Runtime         | Cloudflare Workers            | Next.js 16 (App Router)        |
| Language        | TypeScript 5.3                | TypeScript 5.x (strict)        |
| Database        | Supabase (PostgreSQL) + RLS   | Supabase client + SSR          |
| AI Engine       | Google Gemini 2.5 Flash       | Via worker proxy                |
| Cache           | Redis (fail-open)             | React Query                    |
| State           | —                             | Zustand + React Query           |
| UI              | —                             | shadcn/ui + Tailwind v4         |
| Forms           | —                             | React Hook Form + Zod v4        |
| Bot Framework   | Telegraf                      | —                               |
| CI/CD           | GitHub Actions → Cloudflare   | —                               |

---

## 2. Database Schema

### accounts
| Column      | Type          | Notes                                                          |
| ----------- | ------------- | -------------------------------------------------------------- |
| id          | UUID PK       |                                                                |
| name        | VARCHAR(100)  | e.g., "Bancolombia Debito"                                     |
| type        | ENUM          | checking, savings, credit_card, cash, investment, crypto, credit |
| institution | VARCHAR       | bancolombia, nequi, daviplata, cash, etc                       |
| last_four   | VARCHAR(4)    | Card last 4 digits for matching                                |
| currency    | VARCHAR(3)    | Default: COP                                                   |
| balance     | DECIMAL(15,2) | Updated on every transaction                                   |
| is_active   | BOOLEAN       |                                                                |
| color       | VARCHAR(7)    | Hex color for UI                                               |
| icon        | VARCHAR(50)   |                                                                |
| deleted_at  | TIMESTAMPTZ   | Soft delete                                                    |

### categories
| Column    | Type          | Notes                                  |
| --------- | ------------- | -------------------------------------- |
| id        | UUID PK       |                                        |
| name      | VARCHAR(100)  |                                        |
| slug      | VARCHAR(100)  | UNIQUE lookup key (e.g., "restaurant") |
| type      | ENUM          | expense, income, transfer              |
| parent_id | UUID FK       | Self-referencing for hierarchy         |
| icon      | VARCHAR(50)   |                                        |
| color     | VARCHAR(7)    |                                        |
| is_active | BOOLEAN       |                                        |
| deleted_at| TIMESTAMPTZ   | Soft delete                            |

### transactions
| Column                 | Type          | Notes                                   |
| ---------------------- | ------------- | --------------------------------------- |
| id                     | UUID PK       |                                         |
| date                   | DATE          |                                         |
| time                   | TIME          |                                         |
| amount                 | DECIMAL(15,2) | Always > 0                              |
| description            | TEXT          |                                         |
| notes                  | TEXT          |                                         |
| category_id            | UUID FK       | → categories                            |
| account_id             | UUID FK       | → accounts (NOT NULL)                   |
| type                   | ENUM          | expense, income, transfer               |
| payment_method         | VARCHAR(50)   | debit, credit, cash, transfer, qr       |
| source                 | VARCHAR(50)   | bancolombia_email, nequi_sms, manual, api, web, web-ai |
| confidence             | INTEGER       | 0-100 (Gemini score)                    |
| transfer_to_account_id | UUID FK       | → accounts (for transfers)              |
| transfer_id            | UUID          | Links paired transfer transactions      |
| is_reconciled          | BOOLEAN       |                                         |
| raw_text               | TEXT          | Original message for audit              |
| parsed_data            | JSONB         | Full Gemini response                    |
| applied_rules          | JSONB         | Array of `{rule_id, rule_name, actions}` |
| deleted_at             | TIMESTAMPTZ   | Soft delete                             |

### automation_rules
| Column                 | Type          | Notes                                  |
| ---------------------- | ------------- | -------------------------------------- |
| id                     | UUID PK       |                                        |
| name                   | VARCHAR(200)  |                                        |
| is_active              | BOOLEAN       |                                        |
| priority               | INTEGER       |                                        |
| conditions             | JSONB         | description_contains, description_regex, amount_between, amount_equals, from_account, source |
| actions                | JSONB         | set_type, set_category, link_to_account, auto_reconcile, add_note |
| prompt_text            | TEXT          | Dynamic prompt injected into Gemini    |
| match_phone            | VARCHAR(15)   | For transfer phone matching            |
| transfer_to_account_id | UUID FK       | Transfer destination account           |
| deleted_at             | TIMESTAMPTZ   | Soft delete                            |

### Migrations Applied

1. `20241123000000_initial_schema.sql` — Core tables (accounts, categories, transactions, automation_rules, reconciliations, imports)
2. `20241125000001_add_balance_index.sql` — Performance indexes
3. `20241125000002_add_category_slug.sql` — Category slug field
4. `20241125000003_add_automation_rule_prompt.sql` — Prompt text for Gemini injection
5. `20241125000004_add_credit_account_type.sql` — Added "credit" account type
6. `20241125000005_add_soft_delete.sql` — Soft delete (deleted_at) on all tables
7. `20241125000006_add_applied_rules.sql` — JSONB applied_rules on transactions

---

## 3. Backend (Cloudflare Worker)

### Handlers

| Handler       | Route/Trigger    | Purpose                                              |
| ------------- | ---------------- | ---------------------------------------------------- |
| `telegram.ts` | Webhook          | Telegram bot — `/start`, `/help`, direct messages    |
| `email.ts`    | POST `/email`    | Bancolombia emails via Google Apps Script             |
| `transaction.ts` | POST `/transaction` | REST API — submit text, create transaction        |
| `parse.ts`    | POST `/parse`    | REST API — parse text only (no save), returns structured data |
| `balance.ts`  | GET `/balance`   | REST API — query account balance                     |

### Services

| Service                     | Purpose                                                      |
| --------------------------- | ------------------------------------------------------------ |
| `accounts.service.ts`       | Account resolution (bank + last_four + type), balance management |
| `categories.service.ts`     | Category lookup by slug/ID, hierarchical tree                |
| `transactions.service.ts`   | Transaction CRUD, balance application                        |
| `automation-rules.service.ts` | Rule fetching, condition matching, action application, applied_rules tracking |
| `transfer-processor.ts`     | Transfer detection, phone extraction, dual-transaction creation, prompt building |
| `cache.service.ts`          | Redis caching (SHA256 dedup, category/account cache)         |

### AI Parser (Gemini)

- System prompt with 70+ Colombian expense categories
- Colombian amount parsing (`$119.000,00`, `20k`, `50mil`)
- Source detection (Bancolombia email/SMS, Nequi SMS, manual)
- Payment type inference (debit, credit, cash, transfer, QR)
- Account type inference (checking, savings, credit_card, credit)
- Date/time extraction from bank messages
- Dynamic prompt injection:
  - Transfer rules (phone → internal transfer)
  - Automation rules (conditions → actions as Gemini hints)
  - Custom prompt text per rule

### Transaction Processing Flow

1. Message received → Cache check (SHA256 dedup)
2. Dynamic prompt assembly (transfer rules + automation rules + custom prompts)
3. Gemini AI parsing → structured JSON
4. Account matching (institution + last_four + type → institution only → cash fallback)
5. Category lookup by slug
6. Transfer detection (keywords + phone number → automation rules → dual transactions)
7. Automation rules application (condition matching → type/category/account overrides)
8. Applied rules tracking (JSONB audit trail on transaction)
9. Balance update (expense: subtract, income: add, transfer: subtract source + add destination)
10. Cache store (24h TTL)

---

## 4. Frontend (Next.js Web App)

### Pages

| Route              | Status | Features                                                                 |
| ------------------ | ------ | ------------------------------------------------------------------------ |
| `/login`           | Done   | Supabase email/password auth                                             |
| `/dashboard`       | Done   | Balance overview, summary cards, spending by category, recent transactions, month selector |
| `/transactions`    | Done   | Paginated list, filters (type/account/category/date/search), sort, bulk edit, import/export, AI parse |
| `/accounts`        | Done   | Account cards (clickable → detail), create/edit dialog, balance adjust   |
| `/accounts/[id]`   | Done   | Account detail with filtered transaction list                            |
| `/categories`      | Done   | Hierarchical tree, create/edit/delete, auto-slug generation, responsive  |
| `/automation`      | Done   | Rule list with toggle, create/edit/delete, conditions + actions builder  |
| `/analytics`       | Planned | Charts, date filtering, category breakdowns                             |
| `/settings`        | Planned | User preferences                                                        |

### API Routes (Next.js)

| Route                       | Methods        | Purpose                                                   |
| --------------------------- | -------------- | --------------------------------------------------------- |
| `/api/accounts`             | GET, POST      | List/create accounts                                      |
| `/api/accounts/[id]`        | PUT, DELETE     | Update/delete account                                     |
| `/api/transactions`         | GET, POST      | List/create transactions (POST applies automation rules)   |
| `/api/transactions/[id]`    | PUT, DELETE     | Update/delete transaction                                 |
| `/api/transactions/bulk`    | POST           | Bulk update (type, category, account)                     |
| `/api/transactions/import`  | POST           | CSV import                                                |
| `/api/transactions/parse`   | POST           | Proxy to worker parse + applies automation rules on result |
| `/api/categories`           | GET, POST      | List/create categories                                    |
| `/api/categories/[id]`      | GET, PUT, DELETE | Get (with counts)/update/delete category                 |
| `/api/automation-rules`     | GET, POST      | List/create rules                                         |
| `/api/automation-rules/[id]`| GET, PATCH, DELETE | Get/update/delete rule                                |

### Components

#### Layout & Navigation
- **Sidebar** — Desktop navigation with page links
- **Header** — Top bar with mobile menu (Sheet)
- **AuthGuard** — Route protection, redirects unauthenticated users
- **Dashboard Layout** — Sidebar + header shell, mobile FABs (Plus + AI)

#### Dashboard
- **BalanceOverview** — Account balance cards, total net worth
- **SummaryCards** — Income/expense/balance for selected month
- **SpendingByCategory** — Category breakdown (top categories)
- **RecentTransactions** — Last 10 transactions
- **MonthSelector** — Month picker for dashboard data

#### Transactions
- **TransactionList** — Paginated table with select mode, metadata detail dialog
- **TransactionForm** — Create/edit dialog with "Add another" checkbox, "Or create with AI" button
- **TransactionFiltersBar** — Type, account, category, date range, search filters
- **PeriodSelector** — Quick date range presets
- **AiParseDialog** — AI-powered transaction parsing with:
  - Text input → Gemini parsing via worker
  - Automation rules applied post-parse
  - Shows resolved account/category names (not UUIDs)
  - Shows applied automation rules with action details
  - Indicates overridden fields (strikethrough + Zap icon)
  - "Quick Create", "Create & Next", "Edit & Create", "Re-parse" actions
- **BulkEditDialog** — Multi-select → bulk update type/category/account
- **ImportDialog** — CSV file upload with preview

#### Accounts
- **AccountCreateDialog** — Form with type, institution, last_four, icon, color
- **AccountEditDialog** — Edit fields + balance adjust (direct set or via adjustment transaction)

#### Categories
- Inline management in categories page
- Create parent/child categories
- Auto-slug generation from name
- Delete with transaction count confirmation (unlinking transactions)
- Hierarchical display with expand/collapse

#### Automation
- **AutomationForm** — Create/edit dialog with:
  - Basic: name, priority, active toggle
  - Transfer: match_phone, transfer_to_account_id
  - AI: custom prompt_text for Gemini injection
  - Conditions: description_contains, description_regex, amount range, source filter
  - Actions: set_type, set_category, link_to_account, auto_reconcile, add_note

#### Shared
- **CategorySelectItems** — Hierarchical category dropdown (used in transaction form, bulk edit, automation form)
- **ConfirmDeleteDialog** — Generic typed-confirmation delete dialog

### State Management

| Store                        | Purpose                                              |
| ---------------------------- | ---------------------------------------------------- |
| `transaction-form.store.ts`  | Transaction form open/close, edit mode, AI dialog toggle |

Zustand store with actions: `openNew()`, `openWith(tx)`, `openAi()`, `setAiOpen()`, `close()`

### Key Libraries

| Library        | Location          | Purpose                                   |
| -------------- | ----------------- | ----------------------------------------- |
| `server.ts`    | `lib/api/`        | Admin Supabase client, balance ops, automation rules engine |
| `date.ts`      | `lib/utils/`      | Colombia timezone (America/Bogota) helpers |
| `formatting.ts`| `lib/utils/`      | COP currency formatting                   |
| `export.ts`    | `lib/utils/`      | CSV export                                |
| `slugify.ts`   | `lib/utils/`      | URL-safe slug generation                  |
| `config.ts`    | `lib/`            | Worker URL + API key config               |

### UI/UX Features

- **Dark finance theme** — Custom CSS variables, dark backgrounds, green accent for positive values
- **Responsive design** — Mobile-first, sidebar hidden on mobile, FABs for quick actions
- **Mobile FABs** — Plus button (new transaction) + Sparkles button (AI parse), `md:hidden`
- **AI button styling** — Animated gradient border (purple/blue/cyan) via `ai-gradient-btn` CSS class
- **Transaction metadata dialog** — Source, confidence, notes, raw_text, parsed_data (scrollable JSON), applied_rules, payment method, timestamps
- **Parsed data scroll** — JSON block has own scroll container (`max-h-[150px] overflow-auto`) instead of expanding modal

---

## 5. Automation Rules Engine

### How It Works

Automation rules are applied at two levels:

1. **During AI parsing** — Rules with conditions/actions are injected into the Gemini system prompt as hints, so the AI can proactively apply them during categorization.

2. **Post-parse application** — After Gemini returns results, rules are evaluated server-side against the transaction data. Matching rules override type, category, and transfer account. This happens in:
   - Worker: `AutomationRulesService.applyAutomationRules()`
   - Web API: `POST /api/transactions` and `POST /api/transactions/parse`

### Condition Types

| Condition             | Description                                    |
| --------------------- | ---------------------------------------------- |
| `description_contains`| Array of keywords (OR match, case-insensitive) |
| `description_regex`   | Regular expression match                       |
| `amount_between`      | [min, max] range                               |
| `amount_equals`       | Exact amount match                             |
| `from_account`        | Source account ID match                        |
| `source`              | Array of sources (telegram, email, web, etc.)  |

### Action Types

| Action            | Description                                        |
| ----------------- | -------------------------------------------------- |
| `set_type`        | Override transaction type (expense/income/transfer) |
| `set_category`    | Override category (by ID)                          |
| `link_to_account` | Set transfer_to_account_id + generate transfer_id  |
| `auto_reconcile`  | Mark as reconciled                                 |
| `add_note`        | Append note to transaction                         |

### Transfer Rules

Phone-based transfer rules (`match_phone` field) are handled separately by the transfer processor. When a transfer message contains a known phone number, it creates dual transactions (outgoing + incoming).

The rule's `transfer_to_account_id` is also used as a fallback for `actions.link_to_account` when applying general automation rules.

### Audit Trail

Applied rules are stored as JSONB on each transaction:
```json
[
  {
    "rule_id": "uuid",
    "rule_name": "Transfer to Cash",
    "actions": { "set_type": "transfer", "link_to_account": "uuid" }
  }
]
```

---

## 6. CI/CD

### GitHub Actions Workflow

- **Trigger**: Push to `main` branch
- **Steps**: Install dependencies → Lint → Type check → Deploy to Cloudflare Workers
- **Config**: `.github/workflows/deploy.yml`

---

## 7. Roadmap

### Completed

- [x] Cloudflare Worker with Telegram, Email, API handlers
- [x] Gemini AI parser with Colombian financial patterns
- [x] Supabase database with full schema + RLS
- [x] Internal transfer detection and dual-transaction processing
- [x] Automation rules engine (conditions + actions + prompt injection)
- [x] Applied rules audit trail (JSONB on transactions)
- [x] Redis caching (SHA256 dedup)
- [x] GitHub Actions CI/CD pipeline
- [x] Next.js 16 web app with Supabase Auth
- [x] Dashboard with balance overview, spending by category, recent transactions
- [x] Transaction CRUD with filters, search, pagination, sorting
- [x] Bulk edit (multi-select → update type/category/account)
- [x] CSV import and export
- [x] AI parse dialog (text → Gemini → preview → create/edit)
- [x] AI parse: automation rules applied post-parse with visual indicators
- [x] AI parse: resolved account/category names shown (not UUIDs)
- [x] Account management (7 types, balance adjust, detail page)
- [x] Hierarchical category management (parent/child, auto-slug, delete with transaction count)
- [x] Automation rules CRUD (conditions builder, actions, toggle, prompt text)
- [x] Responsive design (mobile sidebar, FABs, adaptive layouts)
- [x] Mobile FABs: Plus (new transaction) + Sparkles (AI parse)
- [x] "Or create with AI" button in transaction form
- [x] AI button with animated gradient border
- [x] Shared hierarchical CategorySelectItems component
- [x] Transaction metadata dialog (parsed_data with independent scroll)
- [x] Soft delete across all entities
- [x] 2-digit year date parsing fix (DD/MM/YY → YYYY-MM-DD)
- [x] Set Balance fix + stale modal data fix

### In Progress / Next

- [ ] Analytics page — charts, date filtering, category breakdowns, trends
- [ ] Dashboard chart improvements — interactive charts with drill-down
- [ ] Reconciliation workflow — match bank statements with transactions
- [ ] Settings page — user preferences, theme, notification settings
- [ ] Push notifications for new transactions (via Telegram or web push)
- [ ] Multi-currency support (USD, EUR alongside COP)
- [ ] E2E tests with Playwright
- [ ] Unit tests with Vitest
