# Platform Improvements Design — February 2026

## Overview

20+ improvements organized into 5 parallel agent work streams across 2 phases. Backend
(Cloudflare Worker) and frontend (Next.js 16) changes coordinated via database migrations.

---

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Non-transactional message handling | `skipped_messages` table | Audit trail without polluting transactions |
| Rule types | `rule_type` ENUM column | Clean filtering + pre-parse evaluation |
| Condition logic | `condition_logic` per rule | Global toggle (AND/OR) simplifies UX |
| Category translations | `translations` JSONB column | Co-located with category, no extra joins |
| Translation API | Gemini Flash (reuse existing) | Zero additional cost or integration |
| i18n library | next-intl with App Router | Best Next.js App Router support |
| Locale detection | Cookie via proxy.ts | Respects project rule: no middleware.ts |
| Color picker | Preset grid + hex input | 0 dependencies, dark-mode native |
| Date/time picker | shadcn Calendar + custom time | Consistent design system, already partial dep |
| Toast theme | `theme="dark"` on Sonner | One-line fix |
| Category swipe | Reuse SwipeableRow (framer-motion) | Consistent UX with transactions |
| Automation infinite scroll | useInfiniteQuery | Matches transaction page pattern |
| DB triggers | New users only (no backfill) | Existing users already have data |
| AI API fallback | Deferred | Not priority, investigate later |

---

## Phase 1: Parallel Agents (no dependencies between them)

### Agent 1: Backend AI/Parsing + Automation Rules Engine

**Repo:** `spends/` (Cloudflare Worker)
**Files touched:** parsers/gemini.ts, constants/parse-expens-system-prompt.ts, handlers/*.ts,
services/supabase/automation-rules.service.ts, services/transfer-processor.ts, types/rule.ts

#### A1: Non-transactional message detection

**Problem:** Messages like "Bancolombia: tus gastos entre diciembre y enero cambiaron en
$1.615.035" get parsed as transactions.

**Solution:**

1. Add `is_transaction` field to Gemini prompt output schema:
   ```json
   {
     "is_transaction": true,
     "skip_reason": null,
     "amount": 50000,
     ...
   }
   ```

2. Add instruction to prompt:
   ```
   CRITICAL: Before parsing, determine if this is an actual financial transaction.
   If the message is informational (spending summaries, balance inquiries, promotional,
   account alerts without a specific transaction), set is_transaction=false and
   skip_reason="informational|promotional|balance_inquiry|other".

   Examples of NON-transactions:
   - "tus gastos entre diciembre y enero cambiaron en $1.615.035"
   - "Consulta de saldo"
   - "Tu clave dinamica es 123456"
   - "Activa tu tarjeta de credito"
   ```

3. Handler logic:
   ```typescript
   if (!expense.is_transaction) {
     await services.skippedMessages.create({
       user_id: userId,
       raw_text: text,
       source,
       reason: expense.skip_reason ?? 'not_transaction',
     });
     // Return user-friendly message instead of error
     return { status: 'skipped', reason: expense.skip_reason };
   }
   ```

4. New table migration:
   ```sql
   CREATE TABLE skipped_messages (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id UUID NOT NULL REFERENCES auth.users(id),
     raw_text TEXT NOT NULL,
     source VARCHAR(50),
     reason VARCHAR(100),
     parsed_data JSONB,
     created_at TIMESTAMPTZ DEFAULT NOW()
   );
   CREATE INDEX idx_skipped_messages_user ON skipped_messages (user_id, created_at DESC);

   ALTER TABLE skipped_messages ENABLE ROW LEVEL SECURITY;
   CREATE POLICY "users_own_skipped" ON skipped_messages
     FOR ALL TO authenticated USING ((select auth.uid()) = user_id);
   CREATE POLICY "service_role_skipped" ON skipped_messages
     FOR ALL TO service_role USING (true) WITH CHECK (true);
   ```

#### A2: Date/time natural language parsing

**Problem:** "7 de febrero a las 10:30pm" gets stored literally instead of converted.

**Solution:**

1. Expand prompt instructions:
   ```
   Dates/Times:
   - Bank SMS: extract exact date/time (e.g., "23/11/2024 19:47")
   - Natural language: convert to structured format:
     - "7 de febrero" → "07/02/2026" (current year if not specified)
     - "ayer" → yesterday's date in DD/MM/YYYY
     - "el lunes" → last Monday's date
     - "10:30pm" → "22:30"
     - "3 de la tarde" → "15:00"
   - Manual with no date reference: null (system uses current Colombia time)
   ```

2. Post-parse validation in handler:
   ```typescript
   function validateAndFixDate(date: string | null): string | null {
     if (!date) return null;
     // Already in DD/MM/YYYY format
     if (/^\d{2}\/\d{2}\/\d{4}$/.test(date)) return date;
     // Try parsing natural language that Gemini missed
     // ... fallback logic
     return null; // Fall back to current Colombia time
   }
   ```

#### B1: Pre-parse account detection via rule_type

**New column:**
```sql
ALTER TABLE automation_rules
  ADD COLUMN rule_type VARCHAR(30) DEFAULT 'general'
  CHECK (rule_type IN ('general', 'account_detection', 'transfer'));

CREATE INDEX idx_automation_rules_type ON automation_rules (rule_type)
  WHERE deleted_at IS NULL;
```

**Pre-parse flow:**
```
1. Fetch account_detection rules for user
2. Evaluate raw_text against their conditions (raw_text_contains)
3. If match found: inject "This message is from account: {name} (id: {uuid})" into prompt
4. Gemini uses the hint for initial categorization
5. Post-parse: remaining rules (general, transfer) apply as before
```

**Handler change (all handlers):**
```typescript
// Before parseExpense()
const accountRules = allRules.filter(r => r.rule_type === 'account_detection');
const generalRules = allRules.filter(r => r.rule_type !== 'account_detection');

const preMatchedAccount = accountRules.find(rule =>
  services.automationRules.matchesConditions({ raw_text: text }, rule.conditions)
);

const accountHint = preMatchedAccount
  ? `ACCOUNT CONTEXT: This message is from account "${preMatchedAccount.actions.set_account}".`
  : '';

const dynamicPrompts = [
  accountHint,
  ...activePrompts,
  buildTransferPromptSection(transferRules),
  buildAutomationRulesPromptSection(generalRules),
].filter(Boolean);
```

#### B2: Auto-generate account rules

New service method:
```typescript
async generateAccountRules(userId: string): Promise<AutomationRule[]> {
  const accounts = await this.accountsService.getActiveAccounts(userId);
  const rules: CreateRuleInput[] = [];

  for (const account of accounts) {
    if (account.type === 'cash') continue; // Skip cash

    const keywords: string[] = [];
    if (account.institution) keywords.push(account.institution);
    if (account.last_four) keywords.push(account.last_four);
    if (keywords.length === 0) continue;

    rules.push({
      user_id: userId,
      name: `Account: ${account.name}`,
      is_active: true,
      priority: 100,
      rule_type: 'account_detection',
      condition_logic: 'and',
      conditions: { raw_text_contains: keywords },
      actions: { set_account: account.id },
    });
  }

  return rules;
}
```

New API endpoint: `POST /api/automation-rules/generate-account-rules`
- Returns preview of rules to be created
- Accepts confirmation to bulk-insert

#### B3: AND/OR condition logic

**New column:**
```sql
ALTER TABLE automation_rules
  ADD COLUMN condition_logic VARCHAR(3) DEFAULT 'or'
  CHECK (condition_logic IN ('and', 'or'));
```

**Updated matchesConditions:**
```typescript
matchesConditions(
  transaction: Partial<CreateTransactionInput>,
  conditions: AutomationRuleConditions,
  logic: 'and' | 'or' = 'or'
): boolean {
  // For array conditions (description_contains, raw_text_contains)
  if (conditions.description_contains) {
    const matchFn = logic === 'and'
      ? conditions.description_contains.every(...)
      : conditions.description_contains.some(...);
    if (!matchFn) return false;
  }
  // Same pattern for raw_text_contains
  // Non-array conditions unchanged (always exact match)
}
```

---

### Agent 2: Database Triggers + Category Overhaul

**Repo:** `spends/` (migrations + seed)

#### D1: Cash account trigger

```sql
CREATE OR REPLACE FUNCTION public.handle_new_user_default_account()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.accounts (user_id, name, type, institution, currency, color, icon, is_active)
  VALUES (NEW.id, 'Cash', 'cash', 'cash', 'COP', '#10B981', '💵', true);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created_account
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_default_account();
```

#### D2: Default categories trigger

Function that inserts all ~75 categories with parent-child relationships, using a
two-pass approach (parents first with generated UUIDs, then children referencing them).

#### D3: Category changes

**Renaming:**

| Current | New Name | New Slug |
|---------|----------|----------|
| Communication, PC | Technology & Internet | technology |
| missing (under Others) | Uncategorized | uncategorized |
| leisure (under Shopping) | Gaming & Hobbies | gaming-hobbies |
| collections (under Investments) | Art & Collectibles | art-collectibles |
| vehicles-chattels (under Investments) | Vehicle Investments | vehicle-investments |

**Moving:**
- `charity` from Entertainment to Others
- `streaming` + `subscriptions` merged into "Subscriptions & Streaming" (slug: `subscriptions`)

**Keeping as-is:**
- `alcohol-tobacco` stays under Entertainment (per user request)
- `stationery` stays under Shopping
- `jewels` stays under Shopping

**New categories:**

| Name | Slug | Parent | Icon | Color | Type |
|------|------|--------|------|-------|------|
| Delivery | delivery | Food & Drinks | 🛵 | #FF9F43 | expense |
| Cloud Services | cloud-services | Technology | ☁️ | #74B9FF | expense |
| Personal Care | personal-care | Entertainment | 💇 | #FDA7DF | expense |
| Debt Payment | debt-payment | Financial | 💳 | #E17055 | expense |

#### C2 (partial): Translations column

```sql
ALTER TABLE categories ADD COLUMN translations JSONB DEFAULT '{}';
```

Pre-load translations for all default categories in the trigger function:
```json
{
  "en": "Groceries",
  "es": "Supermercado",
  "pt": "Supermercado"
}
```

---

### Agent 4: UI Components

**Repo:** `spends-assistant-web/` (frontend)

#### E1: ColorPicker component

```
components/ui/color-picker.tsx

Structure:
- Popover trigger: colored circle + hex text
- Popover content:
  - 4x4 grid of preset colors (16 curated)
  - Input field for custom hex (with # prefix)
  - Live preview circle
  - "Clear" button to remove color

Preset palette (dark-mode optimized):
#EF4444, #F97316, #F59E0B, #84CC16,
#22C55E, #10B981, #14B8A6, #06B6D4,
#3B82F6, #6366F1, #8B5CF6, #A855F7,
#EC4899, #F43F5E, #6B7280, #1F2937
```

Replaces `<Input type="color">` in:
- `account-create-dialog.tsx`
- `account-edit-dialog.tsx`
- `categories/page.tsx` (create/edit section)

#### E2: DatePicker + TimePicker components

**DatePicker:**
```
components/ui/date-picker.tsx

Structure:
- Popover trigger: formatted date display (e.g., "Feb 15, 2026")
- Popover content: shadcn Calendar component
- Value format: YYYY-MM-DD (internal), localized display

Uses: @radix-ui/react-popover (already installed) + shadcn Calendar
```

**TimePicker:**
```
components/ui/time-picker.tsx

Structure:
- Inline component (no popover needed)
- Two numeric inputs: hours (1-12) + minutes (00-59)
- AM/PM toggle button
- Value format: HH:MM (24h internal)

OR simpler approach:
- Single input with mask "HH:MM" + AM/PM select
- Focus moves automatically between segments
```

Replaces `<Input type="date">` and `<Input type="time">` in:
- Transaction form (create/edit)
- Any other date/time inputs

#### E3: Toast dark mode

```tsx
// providers.tsx
<Toaster position="bottom-center" richColors theme="dark" />
```

#### E4: Timestamp formatting

```typescript
// lib/utils/date.ts
import { format, parseISO } from 'date-fns';
import { es, enUS, ptBR } from 'date-fns/locale';

export function formatDateTime(isoString: string, locale = 'es'): string {
  const localeMap = { es, en: enUS, pt: ptBR };
  return format(parseISO(isoString), "d MMM yyyy, h:mm a", {
    locale: localeMap[locale] ?? es,
  });
}
```

Apply in:
- Transaction metadata dialog (created_at, updated_at)
- Any other timestamp displays

#### E5: Modal scroll fixes

Automation form dialog:
```tsx
<DialogContent className="border-border bg-card max-h-[85dvh] overflow-y-auto sm:max-w-[600px]">
```

AI parse result - applied rules section:
```tsx
<div className="max-h-[200px] overflow-y-auto space-y-2">
  {appliedRules.map(...)}
</div>
```

---

## Phase 2: Dependent Agents (after Phase 1 completes)

### Agent 3: i18n Full Stack

**Repo:** `spends-assistant-web/` (frontend)
**Depends on:** Agent 2 (translations column in categories table)

#### C1: next-intl setup

1. Install: `npm install next-intl`

2. Message files structure:
   ```
   messages/
   ├── en.json
   ├── es.json
   └── pt.json
   ```

3. Each file organized by page/component:
   ```json
   {
     "common": {
       "save": "Save",
       "cancel": "Cancel",
       "delete": "Delete",
       "edit": "Edit",
       "create": "Create",
       "loading": "Loading...",
       "error": "An error occurred",
       "confirm": "Confirm"
     },
     "navigation": {
       "dashboard": "Dashboard",
       "transactions": "Transactions",
       "accounts": "Accounts",
       "categories": "Categories",
       "automation": "Automation Rules",
       "settings": "Settings"
     },
     "dashboard": { ... },
     "transactions": { ... },
     "accounts": { ... },
     "categories": { ... },
     "automation": { ... },
     "settings": { ... }
   }
   ```

4. Provider in root layout:
   ```tsx
   import { NextIntlClientProvider } from 'next-intl';
   import { getLocale, getMessages } from 'next-intl/server';

   export default async function RootLayout({ children }) {
     const locale = await getLocale();
     const messages = await getMessages();
     return (
       <NextIntlClientProvider locale={locale} messages={messages}>
         {children}
       </NextIntlClientProvider>
     );
   }
   ```

5. Request config (i18n/request.ts):
   ```typescript
   import { getRequestConfig } from 'next-intl/server';
   import { cookies } from 'next/headers';

   export default getRequestConfig(async () => {
     const cookieStore = await cookies();
     const locale = cookieStore.get('locale')?.value ?? 'es';
     return {
       locale,
       messages: (await import(`../messages/${locale}.json`)).default,
     };
   });
   ```

6. Extend proxy.ts:
   ```typescript
   // After auth checks, before returning response:
   const localeCookie = request.cookies.get('locale');
   if (!localeCookie) {
     supabaseResponse.cookies.set('locale', 'es', {
       path: '/',
       maxAge: 365 * 24 * 60 * 60,
     });
   }
   ```

#### C2: Category translations

Frontend hook:
```typescript
function useTranslatedCategories() {
  const locale = useLocale();
  const { data: categories } = useCategoryTree();

  return categories?.map(cat => ({
    ...cat,
    displayName: cat.translations?.[locale] ?? cat.name,
    children: cat.children?.map(child => ({
      ...child,
      displayName: child.translations?.[locale] ?? child.name,
    })),
  }));
}
```

Backend translation endpoint (in worker):
```
POST /translate-category
Body: { name: "Comida rapida", source_locale: "es", target_locales: ["en", "pt"] }
Response: { en: "Fast Food", pt: "Comida rapida" }
```

Uses Gemini Flash with a simple translation prompt.

#### C3: Locale preference

1. Add `locale` field to user profile (via app_settings or a user_preferences table)
2. Settings page: language selector dropdown (English, Espanol, Portugues)
3. On change: update DB + set cookie + reload page

---

### Agent 5: UX Polish + Automation Page UI

**Repo:** `spends-assistant-web/` (frontend)
**Depends on:** Agent 1 (rule_type column for filters)

#### B4: Automation page improvements

**Filters:**
```tsx
<div className="flex gap-2 flex-wrap">
  <Select value={ruleTypeFilter} onValueChange={setRuleTypeFilter}>
    <SelectItem value="all">All Types</SelectItem>
    <SelectItem value="account_detection">Account Rules</SelectItem>
    <SelectItem value="general">General Rules</SelectItem>
    <SelectItem value="transfer">Transfer Rules</SelectItem>
  </Select>
  <Button variant={showActive ? 'default' : 'outline'} onClick={toggleActive}>
    {showActive ? 'Active' : 'All'}
  </Button>
</div>
```

**Stable ordering:**
API route change: `ORDER BY priority DESC, created_at DESC`

**Visual tags:**
```tsx
<Badge variant="outline" className={cn(
  rule.rule_type === 'account_detection' && 'border-blue-500 text-blue-400',
  rule.rule_type === 'transfer' && 'border-purple-500 text-purple-400',
  rule.rule_type === 'general' && 'border-gray-500 text-gray-400',
)}>
  {rule.rule_type}
</Badge>
```

#### F1: localStorage persistence

```typescript
// store/ui-store.ts
import { persist } from 'zustand/middleware';

export const useUiStore = create<UiStore>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      locale: 'es',
      // ... actions
    }),
    {
      name: 'spends-ui-v1',
      version: 1,
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
      }),
    }
  )
);
```

#### F2: Categories swipeable rows

- Replace click-to-edit on mobile with SwipeableRow
- Click on parent: toggles expand/collapse of children
- Swipe left on parent or child: reveals Edit + Delete buttons
- Desktop: unchanged (hover buttons remain)

#### F3: AI parse button prominence

- Transaction page: "Create with AI" button full-width with gradient border, larger text
- FAB mobile: increase to h-14 w-14 with label tooltip
- Inside form: "Or create with AI" becomes full-width button with Sparkles icon + text

#### F4: Transaction CTA redirect

```tsx
// When limit reached:
<Link href="/settings?tab=subscription" className="...">
  <AlertTriangle className="h-4 w-4" />
  Upgrade to Pro
</Link>

// Settings page reads tab param:
const searchParams = useSearchParams();
const defaultTab = searchParams.get('tab') ?? 'profile';
```

Show this CTA in:
- Transaction form (create)
- AI parse dialog (before parsing)

#### F5: Infinite scroll for automation

```typescript
// lib/api/queries/automation.queries.ts
export function useInfiniteAutomationRules(filters) {
  return useInfiniteQuery({
    queryKey: automationKeys.infinite(filters),
    queryFn: ({ pageParam = 1 }) => fetchRules({ ...filters, page: pageParam }),
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === PAGE_SIZE ? allPages.length + 1 : undefined,
    initialPageParam: 1,
  });
}
```

API route: add `page` and `limit` query params to `GET /api/automation-rules`

#### F6: Applied rules scroll in AI parse modal

```tsx
{appliedRules.length > 0 && (
  <div className="max-h-[200px] overflow-y-auto rounded-md border p-2 space-y-1">
    {appliedRules.map(rule => (
      <div key={rule.rule_id}>...</div>
    ))}
  </div>
)}
```

---

## Migration Summary

All in one migration file per agent:

**Agent 1:** `20241125000012_parsing_and_rules_engine.sql`
- CREATE TABLE skipped_messages
- ALTER automation_rules ADD rule_type, condition_logic

**Agent 2:** `20241125000013_triggers_and_categories.sql`
- ALTER categories ADD translations JSONB
- Category renames, moves, additions
- CREATE FUNCTION handle_new_user_default_account + trigger
- CREATE FUNCTION handle_new_user_default_categories + trigger

---

## Execution Order

```
Phase 1 (parallel, no deps):
  Agent 1: Backend AI + Rules Engine     ─── ~2-3 days
  Agent 2: DB Triggers + Categories      ─── ~1-2 days
  Agent 4: UI Components                 ─── ~2-3 days

Phase 2 (parallel, after Phase 1):
  Agent 3: i18n Full Stack               ─── ~3-4 days
  Agent 5: UX Polish + Automation UI     ─── ~2-3 days
```

---

## Testing Considerations

- Agent 1: Unit tests for matchesConditions with AND/OR, skipped message detection
- Agent 2: Verify trigger fires on user creation (test in Supabase dashboard)
- Agent 3: Verify locale switching, fallback to category.name when no translation
- Agent 4: Visual testing of color picker, date picker in dark mode
- Agent 5: Mobile testing of swipeable rows on categories, infinite scroll
