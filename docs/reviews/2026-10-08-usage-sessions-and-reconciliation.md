# Usage, sessions, and reconciliation review

## Verified on October 8, 2026

- Production has an active Pro subscription. The sidebar incorrectly rendered the Free allowance even for Pro; it now renders unlimited AI access. Subscription fetch failures must show a retry state, never an inferred Free plan.
- Free settings remain 15 AI requests/month, 50 transactions/month, 4 accounts, 5 automation rules, and 15 categories. This review does not raise them or introduce a dollar spending cap.
- Runtime AI integrations under `src/` use OpenRouter. The old Gemini reference in `CLAUDE.md` was stale documentation.

## AI accounting

| Operation                                | Request quota                                                              | Token and actual USD telemetry | Evidence                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Expense text parsing                     | Reserved before a fresh external parse; cache hits do not reserve again    | Yes                            | `src/handlers/parse.ts`, `src/parsers/expense.ts`                                                         |
| Image extraction                         | One reservation per extraction request, independent of extracted row count | Yes                            | `src/handlers/vision-extract.ts`                                                                          |
| Automation generation                    | Not currently reserved against the monthly parse quota                     | Yes                            | `src/handlers/automation-generate.ts`                                                                     |
| Email triage and merchant classification | Not currently reserved against the monthly parse quota                     | Yes                            | `src/ai/email-triage.ts`, `src/ai/forwarded-email-suggestion.ts`, `src/ai/forwarded-purchase-category.ts` |

Telemetry and request quotas have different purposes. Background operations must not be described as consuming the public parse allowance until their counting policy is implemented. Actual USD telemetry is informational and never enforces a $10 cap. Pro bypasses the request allowance through the existing server policy.

## Sessions

The Supabase management API returned `sessions_single_per_user: false`, `sessions_inactivity_timeout: 0`, `sessions_timebox: 0`, `jwt_exp: 3600`, and refresh-token rotation enabled. These values permit simultaneous devices and renewable sessions without a configured inactivity deadline. A one-hour access token is not a one-hour login session.

Web logout previously called the default global sign-out operation. It now calls `signOut({ scope: 'local' })`, so logging out on one device does not revoke all other devices. The device history UI is not a session revocation console.

References: [Supabase sessions](https://supabase.com/docs/guides/auth/sessions), [sign-out scopes](https://supabase.com/docs/guides/auth/signout).

## Recurring budgets

`20261008000020_recurring_budgets.sql` adds dated recurring rules. A limit can apply only to the selected month or repeat each month. Spending is computed independently for each month. A one-month override leaves the recurring rule in place. A new recurring limit supersedes earlier rules; editing a historical rule cannot revive it beyond a later rule. Stopping from a future month retains earlier history. Existing budgets remain one-month limits.

SQL tests exercise owner boundaries, principal exclusions, monthly overrides, stop behavior, historical edits, and exact contributing transactions in `tests/monthly-budgets-sql.test.ts`.

## Email statements: remaining intake gap

`src/utils/email-mime.ts` currently retains parsed text but does not persist MIME attachments. The email handler also has a 512 KB message size bound. The shipped document upload endpoint accepts images, not PDF statements. Bulk reconciliation of extracted observations does not itself implement emailed PDF extraction.

Next implementation must persist owner-scoped attachments, enforce size/MIME bounds and deduplication, handle encrypted statements through a separate password workflow, and extract drafts without financial posting. An OCR subprocessor must satisfy the approved privacy routing before receiving financial PDFs. Reconciliation then compares date, signed amount, currency, account and available references; ambiguous matches require review, and any new financial transaction remains an explicit audited decision.

## Release verification

The two migrations were applied through the Supabase Management API (HTTP 201) and recorded in migration history. Web deployment `dpl_6VLyfao2TCSpswz1qYFvGwtmP4S7` is Ready at https://my.anotto.app. Landing deployment `dpl_7qFo8PRkqaYH9ZHJQWdc2KFnQAGt` is Ready at https://anotto.app. Backend [deployment run 37870791823](https://github.com/InyerM/spends-assistant-api/actions/runs/37870791823) succeeded. Unauthenticated Worker chat requests return 401. Authenticated personal-data browser testing remains for the owner.

Mobile commit `cf00254` applies device-local logout and a shorter logo cycle; its regression test, typecheck, and scoped ESLint passed. Existing unrelated local mobile changes were preserved. The new chat, budget recurrence, and document reconciliation have not been ported to mobile.
