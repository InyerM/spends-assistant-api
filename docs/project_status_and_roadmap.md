# Spends Assistant — System Understanding & Web Frontend Specification

## 1. System Overview

Spends Assistant is an AI-powered expense tracking microservice that automatically captures, categorizes, and stores financial transactions from multiple input channels. It uses **Google Gemini 2.5 Flash** for natural language parsing of bank notifications and manual entries.

### Current Architecture

```
Input Channels                     Processing Layer              Data Layer
─────────────────                  ─────────────────             ──────────
Telegram Bot ─────────┐
                      │
Bancolombia Email ────┼──→ Cloudflare Worker (TypeScript)
(via Apps Script)     │         │
                      │         ├─ Gemini AI Parser
iOS Shortcut / API ───┘         ├─ Redis Cache (optional)
                                ├─ Transfer Detection
                                ├─ Automation Rules Engine
                                └─ Balance Management
                                         │
                                         ▼
                                   Supabase PostgreSQL
                                   (accounts, categories,
                                    transactions, rules)
```

### Tech Stack (Backend)

| Component          | Technology                    |
| ------------------ | ----------------------------- |
| Runtime            | Cloudflare Workers            |
| Language           | TypeScript 5.3                |
| Database           | Supabase (PostgreSQL) + RLS   |
| AI Engine          | Google Gemini 2.5 Flash       |
| Cache              | Redis (fail-open)             |
| Bot Framework      | Telegraf                      |
| Package Manager    | pnpm                          |
| CI/CD              | GitHub Actions → Cloudflare   |

---

## 2. Database Schema

### accounts
Stores bank accounts and payment methods.

| Column      | Type          | Notes                                              |
| ----------- | ------------- | -------------------------------------------------- |
| id          | UUID PK       |                                                    |
| name        | VARCHAR(100)  | e.g., "Bancolombia Debito"                         |
| type        | ENUM          | checking, savings, credit_card, cash, investment, crypto, credit |
| institution | VARCHAR       | bancolombia, nequi, daviplata, cash, etc           |
| last_four   | VARCHAR(4)    | Card last 4 digits for matching                    |
| currency    | VARCHAR(3)    | Default: COP                                       |
| balance     | DECIMAL(15,2) | Updated on every transaction                       |
| is_active   | BOOLEAN       |                                                    |
| color       | VARCHAR(7)    | Hex color for UI                                   |
| icon        | VARCHAR(50)   |                                                    |

### categories
Hierarchical expense/income categories (70+ total).

| Column    | Type          | Notes                                    |
| --------- | ------------- | ---------------------------------------- |
| id        | UUID PK       |                                          |
| name      | VARCHAR(100)  |                                          |
| slug      | VARCHAR(100)  | UNIQUE lookup key (e.g., "restaurant")   |
| type      | ENUM          | expense, income, transfer                |
| parent_id | UUID FK       | Self-referencing for hierarchy           |
| icon      | VARCHAR(50)   |                                          |
| color     | VARCHAR(7)    |                                          |
| is_active | BOOLEAN       |                                          |

**Category groups**: Food & Drinks, Shopping, Housing, Transportation, Vehicle, Entertainment, Communication, Financial, Investments, Income, and more.

### transactions
Central ledger for all financial movements.

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
| source                 | VARCHAR(50)   | bancolombia_email, nequi_sms, manual, api, web |
| confidence             | INTEGER       | 0-100 (Gemini score)                    |
| transfer_to_account_id | UUID FK       | → accounts (for transfers)              |
| transfer_id            | UUID          | Links paired transfer transactions      |
| is_reconciled          | BOOLEAN       |                                         |
| raw_text               | TEXT          | Original message for audit              |
| parsed_data            | JSONB         | Full Gemini response                    |

### automation_rules
Condition-based rules for automated transaction processing.

| Column                 | Type          | Notes                                  |
| ---------------------- | ------------- | -------------------------------------- |
| id                     | UUID PK       |                                        |
| name                   | VARCHAR(200)  |                                        |
| is_active              | BOOLEAN       |                                        |
| priority               | INTEGER       |                                        |
| conditions             | JSONB         | description_contains, amount_between, etc |
| actions                | JSONB         | set_type, set_category, link_to_account |
| prompt_text            | TEXT          | Dynamic prompt injected into Gemini    |
| match_phone            | VARCHAR(15)   | For transfer phone matching            |
| transfer_to_account_id | UUID FK       | Transfer destination account           |

### reconciliations & imports
Supporting tables for reconciliation workflow and bulk imports.

---

## 3. Core Business Logic

### Transaction Processing Flow
1. Message received → Cache check (SHA256 dedup)
2. Gemini AI parsing → structured JSON (amount, description, category slug, bank, payment_type, source, confidence, date/time, last_four)
3. Account matching (multi-level fallback: institution + last_four + type → institution only → cash)
4. Category lookup by slug
5. Transfer detection (keywords + phone number → automation rules → dual transactions)
6. Balance update (expense: subtract, income: add, transfer: subtract source + add destination)
7. Cache store (24h TTL)

### Amount Parsing
- Colombian format: `$119.000,00` → 119000
- Shorthand: `20k` / `20mil` → 20000
- Currency: COP (Colombian Peso)

### Date/Time
- Timezone: America/Bogota (GMT-5)
- Bank messages: extracted from text
- Manual entries: server-generated current time

---

## 4. Web Frontend Specification (spends-assistant-web)

### Tech Stack (Based on lend-app Standards)

| Technology           | Version | Purpose                          |
| -------------------- | ------- | -------------------------------- |
| Next.js              | 16.x    | App Router framework             |
| React                | 19.x    | UI library                       |
| TypeScript           | 5.x     | Language (strict mode)           |
| Tailwind CSS         | v4      | Utility-first styling            |
| shadcn/ui            | latest  | UI components (New York style)   |
| Radix UI             | latest  | Accessible primitives            |
| Lucide React         | latest  | Icons                            |
| Supabase JS          | ^2.x    | Database client                  |
| @supabase/ssr        | ^0.8.x  | SSR auth helpers                 |
| TanStack React Query | ^5.x    | Server state management          |
| Zustand              | ^5.x    | Client state management          |
| React Hook Form      | ^7.x    | Form handling                    |
| Zod                  | ^4.x    | Schema validation                |
| Sonner               | ^2.x    | Toast notifications              |
| date-fns             | ^4.x    | Date utilities                   |
| Vitest               | ^4.x    | Unit testing                     |
| Playwright           | ^1.x    | E2E testing                      |

### Coding Standards

- **ESLint**: Strict TypeScript — explicit return types, no `any`, consistent type imports, no unused imports, no console, strict equality
- **Prettier**: Single quotes, 100 char width, trailing commas, Tailwind class sort plugin
- **TypeScript**: Strict mode, `@/*` path aliases
- **Components**: Server components by default, `'use client'` only when needed
- **State**: Zustand for auth/UI, React Query for server data
- **Forms**: React Hook Form + Zod + shadcn Form component

### Project Structure

```
spends-assistant-web/
├── app/
│   ├── layout.tsx                      # Root layout + providers
│   ├── page.tsx                        # Redirect → /dashboard
│   ├── globals.css                     # Tailwind v4 + theme tokens
│   ├── providers.tsx                   # React Query + Auth
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   └── layout.tsx
│   └── (dashboard)/
│       ├── layout.tsx                  # Sidebar + header shell
│       ├── dashboard/page.tsx          # Overview
│       ├── transactions/
│       │   ├── page.tsx                # List (filterable, searchable)
│       │   └── [id]/page.tsx           # Detail / edit
│       ├── accounts/page.tsx           # Account management
│       ├── categories/page.tsx         # Category tree
│       ├── automation/page.tsx         # Rules management
│       ├── analytics/page.tsx          # Charts & trends
│       └── settings/page.tsx
├── components/
│   ├── ui/                             # shadcn/ui
│   ├── layout/                         # Sidebar, header, mobile nav
│   ├── transactions/                   # Transaction list, form, filters, card
│   ├── accounts/                       # Account card, form, balance
│   ├── categories/                     # Category tree, form
│   ├── dashboard/                      # Balance overview, recent txns, charts
│   ├── analytics/                      # Spending chart, breakdowns
│   └── guards/                         # Auth guard
├── hooks/
│   ├── use-auth.ts
│   ├── use-transactions.ts
│   ├── use-accounts.ts
│   ├── use-categories.ts
│   └── use-dashboard.ts
├── lib/
│   ├── supabase/
│   │   ├── client.ts                   # Client-side Supabase
│   │   └── server.ts                   # Server-side Supabase
│   ├── api/
│   │   ├── queries/                    # React Query query hooks
│   │   ├── mutations/                  # React Query mutation hooks
│   │   └── query-client.ts
│   ├── env.ts                          # Zod-validated env vars
│   ├── utils.ts                        # cn() + general utils
│   └── utils/
│       ├── date.ts                     # Colombia timezone formatting
│       └── formatting.ts              # COP currency formatting
├── store/
│   ├── auth-store.ts                   # Supabase auth state
│   └── ui-store.ts                     # Sidebar, filters, etc.
├── types/
│   ├── index.ts
│   ├── transaction.ts
│   ├── account.ts
│   ├── category.ts
│   └── automation-rule.ts
├── tests/
├── e2e/
└── [config files]
```

### Pages & Features

#### Dashboard (`/dashboard`)
- Total balance across all active accounts
- Account balance cards (color-coded)
- Recent transactions (last 10-20)
- Spending by category (current month — pie/donut chart)
- Monthly spending trend (last 6 months — bar chart)
- Quick add transaction button

#### Transactions (`/transactions`)
- Paginated/infinite-scroll list
- Filters: date range, account, category, type, payment method, source
- Search by description
- Sort by date or amount
- Each row: date, description, category (icon + name), amount (color by type), account, confidence
- Click → detail/edit page

#### Transaction Create/Edit
- Form: date, time, amount, description, notes, category (searchable dropdown with hierarchy), account, type, payment method
- Zod validation + React Hook Form
- Balance preview after save

#### Accounts (`/accounts`)
- Account cards: name, institution, type badge, last_four, balance, color
- Create/edit account dialog
- Deactivate/reactivate toggle

#### Categories (`/categories`)
- Tree view: parents expand to show children
- Create/edit (name, slug, type, parent, icon, color)
- Spending totals per category
- Deactivate/reactivate toggle

#### Automation Rules (`/automation`)
- Rule list: name, priority, conditions summary, actions summary, active toggle
- Create/edit: conditions builder, actions builder, prompt text, transfer matching

#### Analytics (`/analytics`)
- Date range picker (presets + custom)
- Spending by category breakdown
- Income vs Expenses comparison
- Top merchants by frequency and amount
- Daily/weekly/monthly trends

### Environment Variables

```env
NEXT_PUBLIC_SUPABASE_URL=https://project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

### Implementation Phases

1. **Project Setup** — Next.js 16, all configs, Supabase clients, auth flow, base layout, shadcn/ui, types, env validation
2. **Dashboard & Reads** — Dashboard, transaction list, account list, category tree, React Query hooks
3. **CRUD** — Create/edit/delete transactions, accounts, categories; form validation
4. **Automation & Advanced** — Rules management, transfer handling, reconciliation, bulk ops
5. **Analytics & Polish** — Charts, date filtering, category breakdowns, performance, E2E tests
