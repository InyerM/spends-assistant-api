# Platform Improvements Plan — 7 Agents, 2 Phases

## Context

50+ improvements across auth, settings, usage/limits, translations, AI UX, UI polish, categories, automation, and imports. Organized into 7 parallel agents across 2 phases. Phase 1 has no interdependencies; Phase 2 depends on Phase 1 outputs (new DB columns, endpoints, app_settings).

---

## Phase 1 — Foundation (All Parallel)

### Agent 1: Database Migrations & Schema

**Migration 15: `20241125000015_user_settings_and_enhancements.sql`**

New tables and columns:
- `user_settings` table: `user_id` (PK/FK), `hour_format` ('12h'/'24h' default '12h'), `show_api_keys` (bool default false), `created_at`, `updated_at` — with RLS + auto-create trigger on user signup
- `categories`: add `is_default BOOLEAN DEFAULT false`, `spending_nature` ENUM ('none','want','need','must') DEFAULT 'none'
- `accounts`: add `is_default BOOLEAN DEFAULT false`
- `automation_rules`: add `ai_prompt TEXT` (audit column for AI-generated rules)
- New `app_settings` rows: `support_email`, `faq_url`, `automation_faq_url`

**Migration 16: `20241125000016_update_default_triggers.sql`**

- Update cash account trigger: set `is_default = true`
- Update default categories trigger: set `is_default = true` on all, assign `spending_nature` values (food→need, housing→must, entertainment→want, shopping→want, transportation→need, financial→must, technology→need, investments→none, income→none, others→none, transfer→none)

**Migration 17: `20241125000017_imports_storage_bucket.sql`**

- Create `imports` storage bucket (private)
- RLS: users upload to `{user_id}/` folder, read own files
- Extend `imports` table with: `user_id`, `file_name`, `file_path`, `row_count`, `imported_count`
- Update status constraint to include `completed`/`failed`/`in_progress`

**Files:**
- `spends/supabase/migrations/20241125000015_user_settings_and_enhancements.sql`
- `spends/supabase/migrations/20241125000016_update_default_triggers.sql`
- `spends/supabase/migrations/20241125000017_imports_storage_bucket.sql`

---

### Agent 2: Backend Worker — AI Automation Endpoint

**New endpoint: `POST /automation/generate`**
- Auth: same Bearer token pattern as `/parse` (API key → legacy key → Supabase JWT)
- Input: `{ prompt: string }`
- Process: sends prompt to Gemini with system prompt containing user's accounts, categories, and rule schema examples
- Output: `{ rules: GeneratedRule[], prompt: string }` (preview, NOT auto-saved)
- User flow: preview → edit in form → save via existing POST

**New files:**
- `spends/src/handlers/automation-generate.ts` — handler with auth, context gathering (Promise.all), Gemini call, response parsing
- `spends/src/constants/automation-generate-system-prompt.ts` — detailed system prompt covering rule schema, all rule types, conditions, actions, examples

**Modified files:**
- `spends/src/index.ts` — add route `/automation/generate`
- `spends/src/services/supabase/automation-rules.service.ts` — add `createRuleWithPrompt()` that stores `ai_prompt` column
- `spends/src/services/supabase/accounts.service.ts` — add `getAccounts(userId)` method
- `spends/src/services/supabase/categories.service.ts` — add `getCategories(userId)` method
- `spends/src/types/rule.ts` — add `ai_prompt?: string | null` to `AutomationRule` interface

---

### Agent 3: Translations & i18n Fix

**Spanish (es.json) — systematic tilde and quality fix:**
- All `-cion` endings → `-ción` (configuración, automatización, descripción, transacción, suscripción, etc.)
- `"Anos"` → `"Años"` (CRITICAL — "anos" = "anuses")
- `"Si"` → `"Sí"`, `"Mas"` → `"Más"`, `"Credito"` → `"Crédito"`, `"Metodo"` → `"Método"`
- `"Espanol"` → `"Español"`, `"Ingles"` → `"Inglés"`, `"Portugues"` → `"Portugués"`
- Every occurrence in the file, not just the examples above

**Portuguese (pt.json)** — same accent review (`-acao` → `-ação`, `-acoes` → `-ações`, etc.)

**New translation keys** (all 3 locales, 50+ keys):
- Settings: `changePassword`, `setPassword`, `activeSessions`, `currentSession`, `revokeSession`, `currentPlan`, `proFeatures`, `upgradeToPro`, `comingSoon`, `noNameSet`, `dangerZone`, `deleteAccountHelp`, `contactSupport`, `helpAndSupport`, `faqLink`, `supportEmail`, `hourFormat`, `showApiKeys`
- Security: `currentPassword`, `newPassword`, `confirmPassword`, `passwordUpdated`, `revokeConfirm`, `sessionRevoked`, etc.
- Subscription: `freePlan`, `proPlan`, `monthlyAiParses`, `monthlyTransactions`, `maxAccounts`, `maxCategories`, `maxAutomations`, `unlimited`
- Usage: `usage`, `aiParses`, `transactions`, `usedThisMonth`, `upgradeNow`
- Categories: `isDefault`, `cannotDeleteDefault`, `hideCategory`, `showHidden`, `spendingNature`, `want`, `need`, `must`, `addSubcategory`
- Automation: `createWithAi`, `aiPromptPlaceholder`, `generatePreview`, `conditionsHelp`, `actionsHelp`, `accountTypeTooltip`, `automationFaqLink`
- Import: `dragAndDrop`, `usageLimitExceeded`, `importHistory`
- Register: `verificationSent`, `checkEmail`, `verifyBeforeSignIn`
- AI: `aiParseDescription`, `aiParseTooltip`, `aiDialogDescription`, `orCreateManually`, `limitReachedTooltip`
- Period: `thisMonth`, `thisWeek`, `thisYear`

**Capitalize months** in `period-selector.tsx` — applied same capitalize pattern as `month-selector.tsx`.

**Files:**
- `spends-assistant-web/messages/es.json`
- `spends-assistant-web/messages/en.json`
- `spends-assistant-web/messages/pt.json`
- `spends-assistant-web/components/transactions/period-selector.tsx`

---

### Agent 4: Settings Page, Auth & Help

**Tab URL param sync** — `settings/page.tsx`:
- Controlled `value={tab}` + `onValueChange` with `router.replace()` on tab change

**Danger Zone section** — `components/settings/danger-zone-section.tsx`:
- Card with red accent, delete account text, support email `mailto:` link

**Help section** — `components/settings/help-section.tsx`:
- FAQ link + support email button from `useAppSettings()`

**API keys tab conditional**:
- Only rendered when `user_settings.show_api_keys === true`
- Toggle added in Profile tab Preferences card

**Email verification notice** — `register/page.tsx`:
- After `signUp()` success, shows verification card with Mail icon instead of redirecting

**Password field logic** — `security-tab.tsx`:
- Added `currentPassword` field when user has password provider
- Verifies current password before allowing change

**Settings tabs translations**:
- Security tab: 30+ hardcoded strings replaced with `t()` calls
- API keys tab: 15+ hardcoded strings replaced with `t()` calls
- Subscription tab: already using `t()` calls

**New hook: `hooks/use-user-settings.ts`**:
- `useUserSettings()` with `useQuery` + `useUpdateUserSettings()` with `useMutation`
- Optimistic cache updates

**New API route: `app/api/settings/user-settings/route.ts`**:
- GET: fetch user_settings with graceful PGRST116 handling
- PATCH: upsert with `onConflict: 'user_id'`

**Files:**
- `spends-assistant-web/app/(dashboard)/settings/page.tsx`
- `spends-assistant-web/components/settings/danger-zone-section.tsx` (NEW)
- `spends-assistant-web/components/settings/help-section.tsx` (NEW)
- `spends-assistant-web/components/settings/security-tab.tsx`
- `spends-assistant-web/components/settings/api-keys-tab.tsx`
- `spends-assistant-web/components/settings/profile-tab.tsx`
- `spends-assistant-web/app/(auth)/register/page.tsx`
- `spends-assistant-web/hooks/use-user-settings.ts` (NEW)
- `spends-assistant-web/app/api/settings/user-settings/route.ts` (NEW)

---

### Agent 5: Usage, Limits & Query Invalidation

**Fix limits from app_settings** — `app/api/settings/usage/route.ts`:
- Fetches all limits from `app_settings` instead of hardcoded fallbacks
- Fetches actual counts for accounts, categories, automation_rules
- All 9 queries run in parallel via `Promise.all()`

**Expanded usage response:**
```ts
{
  month, ai_parses_used, ai_parses_limit,
  transactions_count, transactions_limit,
  accounts_count, accounts_limit,
  categories_count, categories_limit,
  automations_count, automations_limit,
}
```

**Server-side limit enforcement:**
- `POST /api/categories` — 403 when category limit reached
- `POST /api/automation-rules` — 403 when automation limit reached (supports bulk)
- `POST /api/transactions/import` — 403 when import would exceed transaction limit

**Query invalidation** — added `usageKeys.all` invalidation to `onSuccess` of:
- Transaction: create, update, bulk update, delete, resolve duplicate
- Account: create, delete
- Category: create, delete
- Automation: create, delete, generate account rules
- Import: after successful import

**Usage card redesign** — `usage-card.tsx`:
- 5 usage bars: AI Parses, Transactions, Accounts, Categories, Automation Rules
- Always-visible "Upgrade" link to `/settings?tab=subscription`
- Fully translated with `useTranslations('dashboard')`

**CTA banners at limits:**
- Transaction form: banner when transactions at limit
- AI parse dialog: banner when AI parses at limit
- Import dialog: warning + disabled button when import would exceed limit

**Subscription tab** — shows all 5 limits, not just AI + transactions

**Dashboard** — UsageCard moved to last position

**Files:**
- `spends-assistant-web/app/api/settings/usage/route.ts`
- `spends-assistant-web/app/api/categories/route.ts`
- `spends-assistant-web/app/api/automation-rules/route.ts`
- `spends-assistant-web/app/api/transactions/import/route.ts`
- `spends-assistant-web/lib/api/mutations/transaction.mutations.ts`
- `spends-assistant-web/lib/api/mutations/account.mutations.ts`
- `spends-assistant-web/lib/api/mutations/category.mutations.ts`
- `spends-assistant-web/lib/api/mutations/automation.mutations.ts`
- `spends-assistant-web/components/dashboard/usage-card.tsx`
- `spends-assistant-web/components/transactions/transaction-form.tsx`
- `spends-assistant-web/components/transactions/ai-parse-dialog.tsx`
- `spends-assistant-web/components/transactions/import-dialog.tsx`
- `spends-assistant-web/components/settings/subscription-tab.tsx`
- `spends-assistant-web/hooks/use-usage.ts`
- `spends-assistant-web/app/(dashboard)/dashboard/page.tsx`

---

### Agent 6: AI Button Redesign & UI Polish

**AI animated border redesign** — `ai-glow-button.tsx` + `globals.css`:
- Cyan→green→yellow rotating gradient (`#06b6d4, #22c55e, #eab308`)
- `@keyframes borderRotate` with `background-position` animation
- Inner: `bg-white dark:bg-card` with `text-foreground`

**AI as primary CTA** — `transaction-form.tsx`:
- New transactions: AI button as primary CTA at top, "or create manually" link reveals form
- Edit mode: manual form directly

**AI parse dialog** — `ai-parse-dialog.tsx`:
- Description below title: "Paste a bank notification, SMS, or describe a transaction..."
- Parse button disabled at limit with "Limit reached" tooltip

**Auto-generate button** — `automation/page.tsx`:
- `animated-border` class applied
- Hidden when all active accounts already have account_detection rules

**Modal border standardization** — `border-border bg-card` on AlertDialogContent/DialogContent

**Automation filter width** — `w-auto min-w-[140px]` on SelectTrigger elements

**Confirm delete state leak** — `key={confirmText}` on DialogContent forces remount

**Swipeable hint** — `swipeable-row.tsx`:
- Animated ChevronLeft indicator on first row
- localStorage `hasSeenSwipeHint` flag, dismisses on first drag

**Date range filter unification** — Dashboard:
- Replaced `MonthSelector` with `PeriodSelector`
- `summary-cards.tsx` and `spending-by-category.tsx` accept `dateFrom`/`dateTo`

**"This month" label** — `period-selector.tsx`:
- Detects current month/week/year and shows translated label

**TimePicker keyboard nav** — `time-picker.tsx`:
- ArrowUp/Down increment/decrement values
- ArrowLeft/Right + Tab move between segments (hours → minutes → AM/PM)

**Import drag-and-drop** — `import-dialog.tsx`:
- `onDragOver`, `onDragEnter`, `onDragLeave`, `onDrop` handlers
- Visual feedback: `border-primary bg-primary/5` on drag over

**Files:**
- `spends-assistant-web/components/ui/ai-glow-button.tsx`
- `spends-assistant-web/app/globals.css`
- `spends-assistant-web/components/transactions/transaction-form.tsx`
- `spends-assistant-web/components/transactions/ai-parse-dialog.tsx`
- `spends-assistant-web/app/(dashboard)/automation/page.tsx`
- `spends-assistant-web/components/settings/api-keys-tab.tsx`
- `spends-assistant-web/components/shared/confirm-delete-dialog.tsx`
- `spends-assistant-web/components/transactions/swipeable-row.tsx`
- `spends-assistant-web/components/transactions/transaction-list.tsx`
- `spends-assistant-web/app/(dashboard)/dashboard/page.tsx`
- `spends-assistant-web/components/dashboard/summary-cards.tsx`
- `spends-assistant-web/components/dashboard/spending-by-category.tsx`
- `spends-assistant-web/components/transactions/period-selector.tsx`
- `spends-assistant-web/components/ui/time-picker.tsx`
- `spends-assistant-web/components/transactions/import-dialog.tsx`

---

## Phase 2 — Integration (Depends on Phase 1)

### Agent 7: Categories, Automation Features & Import History

**Categories page improvements** — `categories/page.tsx`:
- Default categories protected: delete button hidden when `is_default === true`, tooltip shown
- Hide/show categories: eye icon toggle for `is_active`, filter toggle for "Show hidden"
- Slug removed from UI display
- "Add subcategory" only on top-level categories (`parent_id` is null)
- `spending_nature` badge on category cards (color-coded: want=yellow, need=blue, must=red)
- Dynamic category translations via `category.translations[locale]` with `useLocale()`

**Category types updated** — `types/category.ts`:
- Added `is_default`, `spending_nature`, `translations` fields

**Account protection**:
- Frontend: delete button hidden on `is_default === true` accounts
- `DELETE /api/accounts/[id]`: returns 403 if `is_default`
- `DELETE /api/categories/[id]`: returns 403 if `is_default`

**Account types updated** — `types/account.ts`:
- Added `is_default` field

**Automation form enhancements** — `automation-form.tsx`:
- Tooltips for account types, conditions, and actions
- FAQ link from `app_settings.automation_faq_url`

**AI automation creation** — `components/automation/ai-automation-dialog.tsx` (NEW):
- Dialog with textarea for natural language prompt
- "Generate preview" button → calls `POST /automation/generate` worker endpoint
- Displays preview of generated rules in cards
- "Use this rule" populates the automation form
- `animated-border` button styling

**AI automation wired into page** — `automation/page.tsx`:
- "Create with AI" button added
- AiAutomationDialog integrated

**Import improvements**:
- File uploaded to Supabase `imports` bucket after successful CSV import
- Import recorded in `imports` table
- New page `/transactions/imports/page.tsx` showing import history
- New API route `/api/transactions/imports/route.ts` (GET)
- Link to import history from import dialog success

**TimePicker hour format** — `time-picker.tsx`:
- Reads `user_settings.hour_format` from `useUserSettings()`
- 24h mode: 0-23 hours, no AM/PM selector
- 12h mode: 1-12 with AM/PM (default)

**Dynamic account name translations** — `lib/utils/account-translations.ts` (NEW):
- Map for default account names: "Cash" → "Efectivo" (es) / "Dinheiro" (pt)
- `getTranslatedAccountName(name, locale)` utility function

**Files:**
- `spends-assistant-web/app/(dashboard)/categories/page.tsx`
- `spends-assistant-web/types/category.ts`
- `spends-assistant-web/types/account.ts`
- `spends-assistant-web/app/api/accounts/[id]/route.ts`
- `spends-assistant-web/app/api/categories/[id]/route.ts`
- `spends-assistant-web/components/automation/automation-form.tsx`
- `spends-assistant-web/components/automation/ai-automation-dialog.tsx` (NEW)
- `spends-assistant-web/app/(dashboard)/automation/page.tsx`
- `spends-assistant-web/app/(dashboard)/transactions/imports/page.tsx` (NEW)
- `spends-assistant-web/app/api/transactions/imports/route.ts` (NEW)
- `spends-assistant-web/components/transactions/import-dialog.tsx`
- `spends-assistant-web/components/ui/time-picker.tsx`
- `spends-assistant-web/lib/utils/account-translations.ts` (NEW)

**Test fixes:**
- Updated 5 test files to support new `is_default` guard checks and usage limit `Promise.all` queries
- Added test cases for 403 on default account/category deletion

---

## Execution Order

```
PHASE 1 (all 6 agents in parallel):
  Agent 1: DB Migrations & Schema
  Agent 2: Backend AI Automation Endpoint
  Agent 3: Translations & i18n Fix
  Agent 4: Settings, Auth & Help
  Agent 5: Usage, Limits & Invalidation
  Agent 6: AI Button & UI Polish

--- apply migrations, deploy worker ---

PHASE 2 (after Phase 1 complete):
  Agent 7: Categories, Automation, Imports
```

---

## Build Status (Post-Implementation)

- **TypeScript**: 0 errors
- **ESLint**: 0 errors, 1 pre-existing warning (React Hook Form `watch()`)
- **Tests**: 268 passing, 1 pre-existing failure (unrelated `automationKeys` test)

---

## Verification Plan

1. **Translations**: Switch between en/es/pt in settings, verify no "ano" or missing tildes anywhere
2. **Auth flow**: Register new account → verify email notice appears → verify email → login works
3. **Settings tabs**: Navigate tabs → check URL params update → use browser back → returns to previous tab
4. **Limits**: Create transactions until limit → verify 403/error → verify usage card updates → verify CTA shows
5. **AI button**: Verify new cyan→green→yellow animated gradient on all AI buttons (parse, auto-generate, automation AI)
6. **Categories**: Verify default categories can't be deleted, spending_nature shows, subcategory only on parents
7. **Automation AI**: Create rule with AI prompt → verify preview → edit → save → verify ai_prompt stored
8. **Import**: Drag CSV → verify limit check → import → verify file uploaded to bucket → check import history page
9. **Cash account**: Verify "Cash" shows as "Efectivo" in Spanish, cannot be deleted
10. **Mobile**: Swipeable hint visible, bottom nav works, FAB tooltips show
