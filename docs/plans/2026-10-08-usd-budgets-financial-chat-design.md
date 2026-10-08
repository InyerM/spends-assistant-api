# USD, budgets, and financial chat: web-first design

Status: owner-approved product direction on 2026-10-08; implementation pending.

## Product decisions

- COP remains the base and default display currency. USD is the only additional currency exposed in the first release. Internal money types must carry an ISO currency code so amounts cannot be added across currencies accidentally.
- Budgets use monthly category spending limits with soft alerts, rather than funded envelopes. The first release has no rollover. The owner chose this on 2026-10-08.
- The financial chat starts read-only. It may explain spending, income, debt, budgets, and reviewed documents, with links to the records behind each numerical claim. It cannot create or edit financial entries. Personalized buy/sell/hold recommendations for specific investments require separate legal review.
- Web and database contracts ship before mobile parity.

## Existing constraints

- `accounts.currency` exists, but `transactions` has one unqualified `amount`. Existing same-amount transfers would corrupt balances if source and destination account currencies differed. See `supabase/migrations/20241123000000_initial_schema.sql` and the active transaction-writing RPCs.
- Dashboard totals and document posting currently assume COP in several web paths. They must either convert through a defined valuation policy or show separate currency totals.
- Document vector matching did not pass the no-match benchmark. Exact owner-scoped retrieval remains authoritative; pgvector is optional only after a larger benchmark.
- Historical balance baselines and some card postings remain open reconciliation work. Chat and budgets must expose incomplete coverage rather than presenting a complete financial picture.

## USD money contract

Each account holds one balance currency. A dual-currency card has separate COP and USD balance buckets linked under one visible card identity. A transaction preserves the amount and currency shown by its source and the amount and currency actually posted to its account. The posted amount is the balance delta. A cross-currency transfer stores both account legs and their amounts in one audited, owner-scoped operation; its principal is neither income nor spending. Bank or P2P fees are separate spending entries or explicit linked fee components.

Store applied exchange rate, rate direction, source, effective date, and whether the rate was observed from the posting or estimated from a reference quote. The source posting wins for historical financial totals. A daily Banco de la República USD/COP reference rate, available through Frankfurter's provider route, supports estimates and comparisons; it must never silently replace an observed settlement rate. Cache reference quotes by pair and effective date. If a required rate is missing, show the original currency and an unavailable COP total instead of silently omitting or inventing a conversion.

Migrate verified COP transactions without changing their amounts. Review any transaction on a non-COP account or with explicit USD evidence before assigning its source currency. Validate all posting paths, including manual, CSV, Shortcut, forwarded email, document confirmation, corrections, reversals, and mobile sync. Until a path supports USD, it must reject mismatched currencies before a balance write. All financial writes remain atomic and replay-safe.

## Monthly budgets

A budget has an owner, month, category or category group, COP limit, active state, and alert thresholds. Category-group totals include descendants once; overlapping group and child budgets may coexist as separate views but are not added into one grand limit. The first release uses 80% and 100% soft alerts, a progress view, remaining amount, and a drill-down into contributing transactions. Alerts are deduplicated per threshold and month and never block posting.

Budget actuals come from reviewed personal expenses only. Exclude transfers, loan principal, investment contributions, earmarked relief spending, and duplicate or deleted rows; preserve genuine fees, interest, gifts, and purchases. Refunds linked to an original category reduce that category's actuals. Show uncategorized and unverified-currency counts alongside coverage. An expense posted in USD uses its stored settlement-equivalent COP amount when available; an estimated historical reference conversion must be visibly marked as estimated. AI may suggest category limits based on an exact historical aggregate, but a person confirms every budget.

## Financial chat

The chat uses a small set of typed, owner-scoped read tools for transaction filters, category aggregates, budget status, account/loan/investment summaries, and approved document excerpts. Server code executes tools; the model cannot issue arbitrary SQL. Treat document and email content as untrusted source data. Return the relevant date range, currency basis, data freshness, coverage gaps, and source links with answers. If records conflict or no reliable rate exists, state what cannot be concluded.

The existing OpenRouter text adapter, AI consent, request-count quota, and private token/cost telemetry can be extended. Add a distinct consent explanation for querying a wider personal-finance corpus; do not log raw chat content or document excerpts in usage telemetry. Bound tool result sizes and conversation history. Use a cheaper capable model first, with measured escalation only when needed; the USD 10 per-user monthly figure remains a planning target, not a billing or product cutoff. Persist chat history only after defining owner controls, retention, deletion, and evidence-link behavior.

The first release gives educational analysis of spending, budgets, and debt scenarios. It must not generate a personalized instruction to buy, sell, or hold a specific security. Investment summaries can report recorded positions and historical values without giving a product recommendation.

## Delivery issues and gates

1. **WEB-22A: money invariants.** Add explicit COP/USD monetary types and migration, card balance buckets, source/posted amounts, FX metadata, and SQL constraints. Test same-currency compatibility, cross-currency rejection on legacy writers, owner isolation, replay, reversal, and no double counting.
2. **WEB-22B: exchange and transfer flow.** Implement the reviewed cross-currency transfer RPC and USD transaction entry in web. Add reference-rate caching and source-rate comparison. Test actual versus reference rates, fees, missing rates, idempotency, and reconciliation.
3. **WEB-22C: reporting parity.** Convert or separate dashboard, account, transaction, document, import, and investment displays. Verify that every displayed total has a currency basis and that unconverted values remain visible. Do not deploy until audited entry paths are covered.
4. **WEB-41: monthly budgets.** Add owner-scoped budget storage, exact actuals query, limits and alerts, Spanish/English web UI, and transaction drill-down. Test financial-role exclusions, category groups, refunds, USD conversion, month boundaries, and coverage.
5. **WEB-42: grounded financial chat.** Add owner-scoped read tools, source citations, consent, bounded OpenRouter calls, usage telemetry, and read-only web UI. Evaluate numerical accuracy, prompt injection from documents, missing data, model cost, and refusal of specific investment recommendations on a synthetic suite.
6. **MOBILE-USD/BUDGET/CHAT:** adapt local schema and sync only after the corresponding web contracts are stable. No mobile writer may bypass currency invariants.

Release each issue with focused failing tests first, then relevant SQL, typecheck, lint, unit and browser tests. Financial changes require a backup, migration-history review, and staging reconciliation before production deployment.

## External references

- Frankfurter provider and historical-rate API: https://frankfurter.dev/
- Actual Budget tracking budgets: https://actualbudget.org/docs/getting-started/tracking-budget/
- OpenRouter tool calling: https://openrouter.ai/docs/guides/features/tool-calling
- Colombian Financial Superintendence on regulated personalized securities advice: https://www.superfinanciera.gov.co/preguntas-frecuentes/25/25-mercado-publico-de-valores/
