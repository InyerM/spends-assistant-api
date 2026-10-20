# Category context and statement funding correction

## Root causes

1. Category review prohibited marketplace classification and relied on history passed by a category-follow-up RPC that may return no useful context for an uncategorized movement.
2. Account transaction reads filtered only `account_id`, while account analytics included transfers through `transfer_to_account_id`.
3. The empty period label was only enabled when a caller provided a label. Account links intentionally use all history and supplied empty dates without that label.
4. Statement evidence links existed in the full list and provenance panel, but were absent from dashboard, account, contact and budget transaction summaries.
5. Converted payments were immutable outside their creation writer, with no dedicated funding-amount correction workflow.

## Changes

`CategoryReviewContextService` loads up to 12 owned, categorized, related movements; excludes the current transaction; and bounds descriptions and notes. The shared category handler loads active automation rules and history concurrently. Valid matching rules take priority, while the model preserves card-payment and unknown-transfer safeguards. The review model may suggest broad Shopping for a marketplace without inventing purchased items. General text intake and forwarded-email suggestions also receive rule/history context.

Migration `20261020000080` adds immutable funding-correction events and an owner-scoped, terms-gated SQL writer. The writer accepts an expected funding amount and an actual COP amount, preserves original USD evidence, changes only the funding balance by the delta, and reverses/reissues destination statement links. It rejects stale writes, changed retries, foreign owners, existing source reconciliation and potential duplicate debits. The generic transaction guard permits only a matching audit event created in the current database transaction.

## Verification

- Original period and destination-filter regressions failed before their fixes.
- SQL tests verify correction replay, owner isolation, stale/invalid amounts, failed balance update rollback, source-proof blocking, unchanged USD balances/evidence, immutable generic edits and deletion reversal.
- A production-schema migration transaction compared all existing transaction/account/link rows before and after: zero changes.
- Disposable browser owners verified both-currency posting, destination recent records, destination filtered list, home evidence, actual funding correction retaining valid USD proof, and document lifecycle/hash navigation. Cleanup succeeded.
- Real provider checks returned Shopping for an unspecified Mercado Libre purchase, cited owned pet-food history, honored a custom category rule, and did not save analysis suggestions automatically.

Release identifiers and complete browser results are recorded in the web release plan.

Final backend gate: 951 tests across 138 files passed on 2026-10-20 (`/tmp/anotto-account-backend-full-final.log`). Typecheck and lint passed. Worker version `bb9649b9-db3c-45e3-90ed-c134ab26e072` contains this runtime. Migration 80 applied with zero existing financial row changes.
