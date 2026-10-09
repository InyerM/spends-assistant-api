# Account, budget, and transaction review follow-up

## Authorized scope

The owner requested independent sidebar groups, exact account balance targets with and without a financial transaction on web and native mobile, document/email provenance, category corrections on reviewed transactions, editable budget categories, previous-month comparison limits, and immediately visible email review forms while AI suggests metadata. The acceptance checklist is delivered directly in chat as requested.

## Implementation decisions

- Sidebar group state is keyed by group identity and initialized once, so navigating does not reset manual expansion choices.
- The review form opens before analysis resolves. Original amount/date/time remain visible. Account, category, type, description, and notes carry accessible analysis/suggestion labels and existing AI color tokens. User overrides survive late suggestions; cancellation never reopens a closed form. Analysis requests have a bounded timeout.
- `adjust_account_balance` calculates the difference from a locked, owner-scoped authoritative balance. Transaction mode reuses audited manual posting and quotas; manual mode changes the target without a financial row. Both modes persist idempotency evidence and require terms acceptance.
- Native balances use a durable local-only WatermelonDB version 4 outbox, preserving stable request IDs across retry. Regular account updates do not send optimistic balances. Newly created accounts retain their original starting balance until queued targets are applied.
- Reviewed document and active email matches allow category, description, and notes corrections while keeping financial evidence immutable. The original audited link and append-only metadata edit evidence remain intact.
- Transaction detail/edit surfaces show owner-scoped original document/message evidence. Archived documents are revealed by their targeted link. Long filenames truncate within the viewport.
- Budget editing uses the original budget ID, explicit collisions, owner validation, and before/after audit snapshots. Previous-month comparisons apply only to that month, with no current alert claims. Recurring rules retain earlier history and future applicability.

## Verification

- Backend full suite: 96 files / 786 tests passed; latest migration-specific PGlite suite: 4 files / 33 tests passed after all acceptance guards were added.
- Web full suite: 178 files / 1,158 tests passed. Typecheck, production build, changed-file formatting, and lint passed with the existing React Hook Form compiler warning.
- Native full suite: 16 suites / 53 tests passed, typecheck and changed-file lint passed. Global native lint still reports 95 pre-existing findings outside this scope.
- Production migrations 20261008000031, 20261008000032, and 20261008000033 applied through reviewed management queries on October 8, 2026 (Bogota).
- Production synthetic account smoke: exact target/difference, request replay, manual target without a transaction, budget ID/category editing and month isolation, active email metadata editing, financial-edit rejection, unchanged balance, and complete temporary-user cleanup passed.

## Publication and visual review

- Backend code commit: `0df9b29`; CI succeeded at https://github.com/InyerM/spends-assistant-api/actions/runs/37884939998.
- Web release: `2702f02` plus accessible account-action label `d11ba66`; https://my.anotto.app resolves to ready production deployment `dpl_ARTKtssuqrkVRNbZTgKjP64GimjE`.
- Native source commit: `4ce07de`; this is a development-client update, not an App Store release.
- Independent bounded UI review recorded eight screenshot/DOM checks across 1440 px and 390 px, with no blocking observed defects. Long-filename truncation was reviewed in source; the origin screenshot and lower mobile email form were not fully visually inspected. All temporary review users were removed.

## Remaining validation

- Physical iPhone: offline target queue, reconnect/retry, and local schema upgrade. The initial main-branch inspection missed completed native document/inbox and wealth modules on the preserved `feat/anotto-mobile-integration` branch. They are integrated into native main as of 2026-10-09 (`c114b6f`). Native budget/chat parity remains outside this integration.
- Real email delivery to the new receipt domain still needs a genuine sender delivery test; synthetic HTTP and database checks do not establish SMTP delivery.
- Private exports, statements, screenshots, credential files, and temporary synthetic fixtures are excluded from commits.

## Native integration correction — 2026-10-09

- Root cause of the hybrid iPhone interface: Metro served native main with recent loader/settings changes, while the complete Anotto brand and native document/email/wealth/security features remained on `feat/anotto-mobile-integration`.
- Integrated both histories in native commit `c114b6f`, retaining the terms acceptance gate, local-only sign-out, audited target balance outbox, account identifier matching, and read-only managed automation guards.
- Schema v9 and synchronous existing-file preflight preserve both previously published SQLite v3/v4 histories; actual SQLite tests verify queued balance requests and unsynced rows survive main-v4, canonical-v4, and canonical-v8 upgrades. No local database reset is performed. Evidence: native `tests/database/schema-integration.test.ts`.
- Validation: 88 suites / 250 tests passed; full TypeScript and ESLint checks passed. Dependencies installed with `pnpm install --frozen-lockfile`. Local work from the prior main checkout is retained in a named Git stash; unique managed-rule protections were integrated, while superseded pre-brand components were not reapplied.
- Metro restarted with a cleared bundle cache on port 8081. The physical device launch command succeeded; screen-level validation on the owner's unlocked iPhone is still required.
