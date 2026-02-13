# Future Features & Development Roadmap

## Overview

This document outlines the planned features, improvements, and architectural changes for Spends
Assistant. Features are organized into phases based on dependencies and priority.

---

## Phase 0: Foundation — Testing & Multi-User

These are prerequisites for everything else. No new features should be built until user scoping and
test coverage are in place.

### 0.1 Unit & Integration Tests (Vitest)

**Goal**: 80%+ code coverage across backend and frontend.

**Backend (Cloudflare Worker)**:

- Gemini parser: mock AI responses, test amount parsing (`$119.000,00`, `20k`, `50mil`), date
  extraction, source detection
- Automation rules engine: condition matching (description_contains, raw_text_contains,
  amount_between, regex, source), action application (set_type, set_category, set_account,
  add_note, link_to_account), priority ordering
- Transfer processor: transfer detection, phone extraction, dual-transaction creation
- Duplicate detection: exact match (raw_text + source), near match (amount + account + date)
- Transaction handler: date/time parsing from SMS, account resolution, category lookup
- Balance management: expense subtract, income add, transfer dual-update

**Frontend (Next.js)**:

- API routes: GET/POST transactions (filters, pagination, duplicate 409, force/replace), accounts
  CRUD, categories CRUD, automation rules CRUD, parse proxy
- Mutations: DuplicateError handling, force create, replace, resolve duplicate
- Utility functions: date helpers, currency formatting, slug generation, select-items builders
- Components (React Testing Library): SearchableSelect, DuplicateWarningDialog, TransactionForm
  (duplicate flow), AutomationForm (conditions/actions builder)

**Tools**: Vitest, @testing-library/react, MSW (for API mocking)

### 0.2 E2E Tests (Playwright)

**Goal**: Cover critical user flows end-to-end.

**Setup**:

- Dedicated test Supabase project (or test schema)
- `globalSetup`: create test user, seed accounts/categories/rules
- `storageState`: persist auth session across tests (login once)
- `globalTeardown`: clean up test data

**Critical flows to test**:

1. Login → redirect to dashboard
2. Create transaction (manual form) → appears in list
3. AI parse → preview → quick create → appears in list
4. Duplicate detection: create same transaction twice → 409 → warning dialog → create anyway /
   replace
5. Automation rules: create rule → send matching transaction → verify rule applied
6. Bulk edit: select multiple → change category → verify
7. Account balance: create expense → balance decreases
8. Mobile: bottom nav navigation, swipeable rows

### 0.3 Multi-User Support

**Goal**: Every user sees only their own data. This is the architectural foundation for all future
features.

**Database migration**:

```sql
-- Add user_id to all data tables
ALTER TABLE accounts ADD COLUMN user_id UUID NOT NULL REFERENCES auth.users(id);
ALTER TABLE categories ADD COLUMN user_id UUID NOT NULL REFERENCES auth.users(id);
ALTER TABLE transactions ADD COLUMN user_id UUID NOT NULL REFERENCES auth.users(id);
ALTER TABLE automation_rules ADD COLUMN user_id UUID NOT NULL REFERENCES auth.users(id);
ALTER TABLE reconciliations ADD COLUMN user_id UUID NOT NULL REFERENCES auth.users(id);
ALTER TABLE imports ADD COLUMN user_id UUID NOT NULL REFERENCES auth.users(id);

-- Create composite indexes
CREATE INDEX idx_accounts_user ON accounts (user_id);
CREATE INDEX idx_transactions_user_date ON transactions (user_id, date);
CREATE INDEX idx_categories_user ON categories (user_id);
CREATE INDEX idx_automation_rules_user ON automation_rules (user_id);

-- Rewrite RLS policies (example for transactions)
DROP POLICY IF EXISTS "service_role_all" ON transactions;
CREATE POLICY "users_own_data" ON transactions
  FOR ALL USING (user_id = auth.uid());
-- Keep service role access for backend worker
CREATE POLICY "service_role_full" ON transactions
  FOR ALL TO service_role USING (true);
```

**Backend changes**:

- All services receive `user_id` parameter and pass it to inserts
- Transaction handler: extract user from API key mapping or request body
- Cache keys include user_id to prevent cross-user cache hits

**Frontend changes**:

- Replace `getAdminClient()` with user-scoped Supabase client in API routes
- Pass `auth.uid()` from session to all queries
- API routes validate JWT and extract user context
- Registration flow (currently login-only)

**Data migration for existing single-user data**:

- Backfill `user_id` on all existing rows with the current user's ID
- Run as a one-time migration script

---

## Phase 1: Budgets & Financial Goals

### 1.1 Budgets

**Goal**: Set spending limits per category (or globally) per period, with tracking and alerts.

**Database**:

```
budgets
├── id UUID PK
├── user_id UUID FK → auth.users
├── name VARCHAR (e.g., "Groceries Monthly")
├── category_id UUID FK → categories (nullable for global budgets)
├── amount DECIMAL(15,2) — budget limit
├── period ENUM: weekly, biweekly, monthly, yearly
├── start_date DATE — when the budget cycle starts
├── is_active BOOLEAN
├── created_at, updated_at
```

**Features**:

- Dashboard widget: budget progress bars (spent / limit) per category
- Color coding: green (<70%), amber (70-90%), red (>90%), over-budget indicator
- Budget vs actual report: table with variance analysis
- Rollover option: carry unused budget to next period (or not)
- Support for category groups: budget for a parent category covers all children

**AI integration**: "Analyze my spending and suggest budgets" — Gemini reviews last 3 months of
transactions and proposes category budgets.

### 1.2 Financial Goals

**Goal**: Track savings targets with progress visualization.

**Database**:

```
goals
├── id UUID PK
├── user_id UUID FK → auth.users
├── name VARCHAR (e.g., "Emergency Fund", "Vacation")
├── target_amount DECIMAL(15,2)
├── current_amount DECIMAL(15,2)
├── target_date DATE (optional)
├── account_id UUID FK → accounts (optional, link to savings account)
├── is_completed BOOLEAN
├── created_at, updated_at
```

**Features**:

- Goal cards on dashboard with progress ring/bar
- Auto-track: link a goal to a savings account, auto-update current_amount from account balance
- Manual contributions: log deposits toward a goal
- Projected completion date based on current savings rate
- Milestone notifications (25%, 50%, 75%, 100%)

---

## Phase 2: Notifications & Alerts

### 2.1 Notification System

**Goal**: Proactive alerts for budget limits, goals, anomalies, and summaries.

**Database**:

```
notification_preferences
├── id UUID PK
├── user_id UUID FK → auth.users
├── channel ENUM: email, telegram, web_push
├── type ENUM: budget_alert, goal_milestone, weekly_summary, monthly_report, anomaly, low_balance
├── is_enabled BOOLEAN
├── threshold DECIMAL (e.g., 90 for "alert at 90% of budget")
├── created_at, updated_at

notification_log
├── id UUID PK
├── user_id UUID FK → auth.users
├── type VARCHAR
├── channel VARCHAR
├── title TEXT
├── body TEXT
├── data JSONB (context: budget_id, goal_id, etc.)
├── is_read BOOLEAN
├── sent_at TIMESTAMPTZ
```

**Notification types**:

| Type | Trigger | Example |
| --- | --- | --- |
| Budget alert | Spending hits threshold (70%, 90%, 100%) | "Groceries budget is at 92% ($460k / $500k COP)" |
| Goal milestone | Goal reaches 25/50/75/100% | "Emergency Fund is 50% funded!" |
| Weekly summary | Scheduled (Sunday evening) | "This week: $1.2M spent, top category: Food" |
| Monthly report | Scheduled (1st of month) | "January: $4.5M spent, $2.1M income, +$200k vs budget" |
| Anomaly detection | Unusually large transaction | "Unusual: $2M at Exito (3x your average grocery spend)" |
| Low balance | Account balance below threshold | "Bancolombia checking below $500k" |

**Delivery channels**:

- **Email**: Resend or Supabase email (already have Supabase)
- **Telegram**: Already integrated — reuse the bot to send messages
- **Web push**: Service Worker + Push API (for the web app)

**Implementation**:

- Cron-triggered Cloudflare Worker (or Supabase Edge Function) for scheduled notifications
- Real-time checks on transaction creation for budget/anomaly alerts
- Notification bell icon in header with unread count

---

## Phase 3: Reconciliation

### 3.1 Bank Statement Reconciliation

**Goal**: Match bank statement entries against recorded transactions to find discrepancies.

**Research findings for Colombia (Bancolombia)**:

- Bancolombia does **not** export CSV/Excel — only PDF statements
- Statements are available monthly from Sucursal Virtual
- Open-source Chrome extension ([bancolombia-extractor](https://github.com/techdev5521/bancolombia-extractor))
  can scrape transactions to CSV
- Colombia's Open Finance Phase 3 (2025-2026) will eventually enable direct transaction pulls via
  AIS (Account Information Services)
- Third-party aggregators (Belvo, Finerio Connect) cover 90%+ of Colombian banks but are paid
  services — overkill for personal use

**Approach — PDF import with AI parsing**:

1. User uploads Bancolombia PDF statement
2. Backend extracts text from PDF (pdf-parse or Gemini vision)
3. Gemini AI structures the extracted data into transactions (date, description, amount, balance)
4. System matches each statement entry against existing transactions:
   - **Exact match**: same date + amount + account → auto-reconcile
   - **Fuzzy match**: close date (±1 day) + same amount → suggest match
   - **Unmatched**: statement entries with no transaction → suggest creation
   - **Missing**: transactions with no statement entry → flag for review
5. User reviews matches and confirms/rejects

**Database**:

```
reconciliation_sessions
├── id UUID PK
├── user_id UUID FK
├── account_id UUID FK
├── statement_start_date DATE
├── statement_end_date DATE
├── statement_balance DECIMAL
├── status ENUM: in_progress, completed
├── file_url TEXT (uploaded PDF)
├── created_at

reconciliation_matches
├── id UUID PK
├── session_id UUID FK → reconciliation_sessions
├── transaction_id UUID FK → transactions (nullable)
├── statement_date DATE
├── statement_description TEXT
├── statement_amount DECIMAL
├── match_type ENUM: exact, fuzzy, unmatched, missing
├── status ENUM: pending, confirmed, rejected, created
├── created_at
```

**Future**: When Colombia's Open Finance AIS is available, add direct bank connection as an
alternative to PDF upload.

---

## Phase 4: Advanced AI Features

### 4.1 AI-Powered Automation Rule Creation

**Goal**: Describe what you want in natural language, AI creates the automation rule.

**Example prompts**:

- "When I pay Claro, categorize as phone and add a note with the bill details"
- "All transactions from Nequi under 50k should be categorized as food"
- "Transfers to my savings account should be tracked as savings"

**Implementation**:

- New "Create with AI" button in automation rules page
- User types a prompt → Gemini generates the conditions + actions JSON
- Preview the generated rule → user confirms or edits → save
- Use few-shot examples from existing rules as context

### 4.2 AI-Powered Category Suggestions

**Goal**: AI suggests new categories based on uncategorized transactions.

- Analyze transactions without categories
- Cluster by description patterns
- Suggest new categories with names and parent assignments
- Batch-assign suggested categories to matching transactions

### 4.3 AI Financial Insights

**Goal**: Natural language analysis of spending patterns.

- "How much did I spend on food last month compared to the month before?"
- "What's my biggest expense category this year?"
- "Am I on track with my grocery budget?"
- Chat-style interface that queries transaction data and responds with insights
- Could use Gemini with function calling to query the database

### 4.4 Smart Categorization Learning

**Goal**: Learn from user corrections to improve future categorization.

- Track when users change AI-assigned categories
- Build a per-user correction history
- Inject correction patterns into the Gemini system prompt
- Gradually improve accuracy without retraining

---

## Phase 5: Internationalization (i18n)

### 5.1 Frontend i18n

**Goal**: Support multiple languages in the web app.

**Approach**: `next-intl` with the App Router.

**Scope**:

- All UI strings (labels, buttons, placeholders, toasts, validation messages)
- Date/time formatting (locale-aware)
- Number/currency formatting (locale-aware)
- Initial languages: English (en), Spanish (es-CO)

**Effort**: ~300+ strings to extract from components.

### 5.2 Backend i18n

**Goal**: Locale-aware AI parsing and notifications.

- Gemini system prompt templates per locale (different banks, categories, amount formats per
  country)
- Notification templates per language
- Category seed data per locale (Colombian categories vs generic)

### 5.3 Multi-Currency Support

**Goal**: Support multiple currencies alongside COP.

**Database changes**:

- Accounts: `currency` field already exists (VARCHAR(3), default COP)
- Transactions: add `currency` field (inherit from account)
- Exchange rates: new table or API integration for conversion

**Features**:

- Dashboard totals in user's base currency
- Transaction amounts displayed in original currency with conversion
- Exchange rate source: free API (exchangerate-api.com, frankfurter.app)
- Historical rates for accurate reporting

**Considerations**:

- Budget limits per currency or converted to base
- Goals tracked in specific currency
- Reports with currency breakdown

---

## Phase 6: Mobile App

### 6.1 React Native / Expo App

**Goal**: Native mobile app for iOS and Android.

**Long-term objective** — the web app covers mobile use cases well with the current bottom nav,
swipeable rows, and responsive design. A native app adds:

- Push notifications (native)
- Offline support
- Camera for receipt scanning
- Share extension for SMS forwarding (alternative to iOS Shortcuts)
- Biometric auth (Face ID / fingerprint)
- Widgets (balance summary on home screen)

**Shared infrastructure**:

- Same Supabase backend + Cloudflare Worker
- Same API routes (or direct Supabase client)
- Shared types (publish as internal package)

---

## Priority Summary

| Phase | Priority | Depends On | Estimated Effort |
| --- | --- | --- | --- |
| 0.1 Unit tests (80%+ coverage) | **Immediate** | — | 1-2 weeks |
| 0.2 E2E tests (critical flows) | **Immediate** | 0.1 | 1 week |
| 0.3 Multi-user support | **High** | 0.1, 0.2 | 1 week |
| 1.1 Budgets | High | 0.3 | 1 week |
| 1.2 Financial goals | Medium | 0.3 | 1 week |
| 2 Notifications & alerts | High | 0.3, 1.1 | 1-2 weeks |
| 3 Reconciliation (PDF) | Medium | 0.3 | 1-2 weeks |
| 4.1 AI automation creation | Medium | 0.3 | 3-5 days |
| 4.2 AI category suggestions | Low | 0.3 | 2-3 days |
| 4.3 AI financial insights | Low | 1.1 | 1 week |
| 4.4 Smart categorization | Low | 0.3 | 3-5 days |
| 5.1 Frontend i18n | Low | 0.3 | 1 week |
| 5.2 Backend i18n | Low | 5.1 | 1 week |
| 5.3 Multi-currency | Low | 5.1 | 1 week |
| 6 Mobile app | Future | 0.3, 5.1 | 4-6 weeks |

---

## Architecture Decisions Log

| Decision | Choice | Rationale |
| --- | --- | --- |
| Testing framework | Vitest + Playwright | Already installed, fast, good DX |
| i18n library | next-intl | Best App Router support for Next.js |
| Notification delivery | Telegram + Email first | Already have Telegram bot; email via Supabase |
| Reconciliation source | PDF upload + AI parsing | Bancolombia doesn't export CSV; AI handles PDF well |
| Multi-currency rates | Free exchange rate API | Personal use, no need for real-time trading rates |
| Mobile framework | React Native / Expo | Share TypeScript types and patterns with web |
| Budget enforcement | Notification-based (soft) | Don't block transactions, just alert |
| User scoping | RLS + application layer | RLS for security, app layer for convenience |
