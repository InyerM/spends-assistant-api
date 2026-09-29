# Spends Assistant restart: audit and initial design

Date: 2026-09-28. Status: draft for joint review and explicit approval before the roadmap phases. Production records were inspected read-only and were not changed.

## Evidence and starting point

The latest backend commit is from 2026-02-25, web from 2026-02-21, and mobile from 2026-02-26. Web and backend were clean at the start of this review. Mobile had uncommitted local changes to automation, synchronization, accounts, categories, subscriptions, and translations; those changes have been preserved.

| Area           | Existing functionality                                                                                          | Verified work remaining                                                                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ingestion      | Worker with Telegram, email, `/transaction`, and `/parse`; web and mobile call the Worker                       | At the start of the audit Gemini was embedded in the parser and rule generation. The local code now uses OpenRouter; there is still no dollar spending limit or evaluated production rollout. |
| Imports        | Web and mobile CSV imports, a private `imports` bucket, import history, and a web duplicate check before import | The web import API inserts rows without rechecking duplicates; mobile creates imports with fields incompatible with the remote `imports` table and does not check duplicates.                 |
| Documents      | Private bucket for CSV files and an `imports` table                                                             | No OCR, document classification, extraction of multiple receipts, pgvector, or document-to-transaction links.                                                                                 |
| Reconciliation | `reconciliations` table and fields on `transactions`                                                            | No complete proposal, evidence, and approval flow.                                                                                                                                            |
| Net worth      | `investment`, `crypto`, and `credit` account types                                                              | No positions, valuations, cost basis, amortization, interest, or separation of liabilities from everyday spending.                                                                            |
| Mobile         | Expo/WatermelonDB, importer, and recent local UI changes                                                        | Synchronization has no explicit pagination and converts read errors to empty sets. Check the `imports` schema and synchronization tests before a historical import.                           |

`docs/project_status_and_roadmap.md` describes an earlier stage and does not reflect all development from February 2026. Use the current code, migrations, and tests for prioritization.

### Read-only production audit

The resumed Supabase project returned **2,110 transactions** across two users: **1,539 active** and **571 soft-deleted**. The account with the most data has **1,516 active transactions** dated from 2024-03-27 through 2026-09-07; the other has 23. The largest account is the likely target for the historical review, but its ownership has not been independently confirmed. No raw text, names, account identifiers, or balances were written to this document.

| Signal in the largest account                   |                                                        Count | Planning implication                                                |
| ----------------------------------------------- | -----------------------------------------------------------: | ------------------------------------------------------------------- |
| `sms-shortcut`                                  |                          705, including 226 without category | Prioritize Shortcut intake and category review.                     |
| `csv_import`                                    | 504, including 62 without category and 31 empty descriptions | Include CSV cleanup and description proposals.                      |
| `sms-bulk`                                      |                            250, including 3 without category | Reuse existing batch examples for parser evaluation.                |
| Category missing / `uncategorized`              |                                                     292 / 51 | Review 343 records before any automatic category rewrite.           |
| CSV source rows linked to an import record      |                                                    24 of 504 | Investigate the 480 unlinked rows before relying on import history. |
| Duplicate status `pending_review` / `confirmed` |                                                      14 / 15 | Resolve pending cases before a large backfill.                      |
| Reconciled transactions                         |                                                            0 | Reconciliation needs a complete workflow.                           |
| Same date, account, and amount groups           |                                   20 groups covering 43 rows | These are candidates for review, not proven duplicates.             |

The largest account has ten active accounts, all in COP. None is named for Tyba or Binance; two match Lulo. These are name-based checks, so missing naming does not prove an investment or loan is absent. The latest month has 17 transactions through September 7; do not assume September 8 onward is complete. Source totals and category gaps were calculated across every active row in that account. The 571 soft-deleted records were counted but not treated as transactions to reimport.

## Proposed decisions

### 1. Models and budget

Three approaches were compared: one model for every task, task-specific model selection, and self-hosted inference. I recommend task-specific selection: **DeepSeek V4.1 Flash** for SMS and text, **Qwen3 VL 30B A3B Instruct** for images and documents, and a larger model only for uncertain cases. This allows cost and quality to be measured by task without paying for vision on every message. Self-hosting adds operational work without a clear benefit for one user.

The Worker should expose a single AI interface for parsing and rules, with a configurable model for each task. All financial requests should use `provider: { zdr: true, data_collection: 'deny' }` and a maximum token price. Filter providers at request time. DeepInfra, NovitaAI, and Relace are candidates, but verify each model/provider combination before enabling it. Do not pin a provider that may stop offering a model. Do not upload files to persistent provider storage; use private images transiently for vision requests.

The target is **under US$10 per person per month**. An OpenRouter key limit provides another guardrail, but a multiuser product also needs its own per-user monthly counter. Record model, provider, tokens, actual cost returned by the API, task class, outcome, and an identifier that contains no financial content. Reserve budget before large jobs, block processing when estimated cost exceeds the remaining balance, and show estimated cost for OCR batches. Manual review should incur no AI cost.

Before changing production, create an anonymized evaluation set of SMS messages, Nequi transfers, other transfers, and informational messages. Compare the current Gemini integration with candidate models on amount/date/account accuracy, detection of non-transactions, category quality, false duplicates, latency, and cost. Validate structured JSON output. Invalid responses should go to review and never be saved automatically.

### 2. Duplicate-safe historical capture

Three approaches were compared: a temporary server collecting JSON, direct submission to the current endpoint, and a persistent import inbox. I recommend the persistent inbox. It receives batches from iOS Shortcuts, stores original text in a private Supabase area, allows private JSON export for analysis, and preserves a reviewable state. A temporary server puts sensitive data outside the main schema and loses traceability. The current endpoint can save a flagged duplicate and alter balances.

The Shortcut should send small authenticated batches with `source`, a message identifier when available, receipt timestamp, and text. The endpoint should return a per-item result: received, previously received, possible existing transaction, non-transaction, or error. The idempotency key must distinguish a repeated copy of one message from separate payments of the same amount. At minimum, use user + source + stable external ID; without an ID, use a hash of normalized text and timestamp. Deduplicate against existing transactions using graded signals: bank reference, account and amount, date/time, counterparty, text, and document. Matches based only on account + amount + date are **possible** duplicates and must not be silently discarded.

Analyze ambiguous Nequi records in groups using counterparty, amount, weekday, time, periodicity, and context from other movements. Each category proposal should include evidence, confidence, and a bulk correction option. Decision history can help learn rules for a recipient. Import confirmation should be explicit. Create transactions and update balances atomically, and recheck duplicates at confirmation time.

### 3. Documents, OCR, and reconciliation

Create one flow, `upload → classify → extract → validate → match → review → confirm`, for bank screenshots, single receipts, multiple receipts in one image, SMS screenshots, statements, and PDFs. Store the binary file in private Storage under the user's folder. A `documents` table should hold type, origin, hash, processing status, model, extractor version, and errors. A `document_observations` table should hold each extracted movement, with page/region evidence and normalized fields. Multiple receipts in one image should produce multiple observations linked to the original document. OCR must not create transactions directly.

Use PostgreSQL for state and financial data. `pgvector` should store **embeddings of extracted text** for semantic search and matching assistance; it does not replace state columns or exact keys. Measure record volume and query patterns before adding a vector index. Compare references, account, amount, and date deterministically first; semantic similarity is an auxiliary signal. Reconciliation should present candidate document/transaction pairs and balance differences, with approval, rejection, and an audit trail of the decision maker. Users should be able to correct OCR before saving.

### 4. Investments and loans

Three models were compared: spending categories, accounts with aggregate values, and asset/liability subrecords. I recommend subrecords: they keep the account view simple while explaining balances. Contributions to Tyba and Binance are transfers between assets. Buys and sells change positions, quantity, cost basis, currency, and fees. Save valuations as dated snapshots and distinguish realized returns, unrealized returns, and dividends. The Lulo and Bancolombia loans are liabilities with initial principal, outstanding balance, rate, term, installment, and schedule. Split each payment into principal, interest, insurance, and fees. A disbursement increases cash and debt; it is not disposable income. An entire loan installment must not be treated as an expense.

Implement the schema and web views for positions, loans, movements, valuations, and net worth first. Then add mobile models, synchronization, and views. Load the user's figures from documents or manual review; do not infer opening balances from approximate amounts.

### 5. Data quality and prompts

With actual Supabase access, audit **all of the user's records** in pages without writing sensitive data to logs or Git documents. Measure source, period, type, missing or incompatible categories, confidence, duplicates, imports, transactions without a clear account, calculated versus reported balances, generic descriptions, and transfers recorded as expenses. Generate reviewable, reversible proposals in the form `before → after → reason → confidence`. Do not bulk rewrite historical records based on a model inference.

The current prompt contains static categories, while actual categories belong to each user. It also has a poorly worded source rule. Prompt revisions should use the user's effective category catalog, rules, and difficult evaluation examples, reduce unnecessary information, and validate structured output. Measure quality before and after; a model's brand alone does not guarantee better categorization.

## Execution order

1. **Stabilize the foundation:** Supabase credentials and connectivity; fix older Worker tests; check mobile synchronization, pagination, import schema, and balances. Take a backup before changing historical data.
2. **Text AI:** common OpenRouter client, task-specific configuration, privacy and budget controls, evaluation set, and migration of parsing/rule generation. Deploy after comparing results.
3. **Historical capture:** inbox and Shortcut, private JSON export, duplicate checks at confirmation, Nequi group review, and batch import.
4. **OCR and reconciliation:** Storage, observations, multimodal extraction, review, reconciliation, and semantic search if it proves useful.
5. **Web net worth:** investments, positions, and loans. Then mobile parity and synchronization tests.
6. **Historical improvements:** full audit, description/category suggestions, and approved batch application.

## Implementation workflow

Use the smallest capable model and the minimum repository context needed for each task. Delegate only independent, clearly scoped work. For behavior changes, write a failing test first, implement the change, then run focused checks and any required repository checks. Report what was verified and any remaining uncertainty explicitly. See `docs/usage/token-usage-agent-prompt.md` for the full workflow.

## Observed blockers and limits

- Supabase was paused at the start of this review. After it was resumed, read-only pagination worked and produced the aggregate audit above. The database has not been modified.
- The local Worker migration uses OpenRouter for text parsing and rule generation. No `OPENROUTER_API_KEY` is configured, candidate models have not been compared on personal messages, and no API spending has occurred. The migration is not ready to deploy.
- The user requested explicit approval before implementing the larger roadmap. The local OpenRouter migration and English documentation cleanup were already in progress when that boundary was set; no other roadmap phase has begun.
- Web: TypeScript and 490 tests pass. Backend: TypeScript and lint pass after explicitly setting module resolution; 174 tests pass and the same 12 baseline tests fail. Mobile: TypeScript and 26 tests pass after declaring missing Babel dependencies. The repository-wide backend Prettier check still reports pre-existing formatting differences.

## External references

- [OpenRouter: DeepSeek V4.1 Flash](https://openrouter.ai/deepseek/deepseek-v4.1-flash)
- [OpenRouter: Qwen3 VL 30B A3B Instruct](https://openrouter.ai/qwen/qwen3-vl-30b-a3b-instruct/api)
- [OpenRouter: provider policies](https://openrouter.ai/providers/)
- [OpenRouter: ZDR and training controls](https://openrouter.ai/docs/guides/get-started/sovereign-ai)
- [OpenRouter: per-key spending limits](https://openrouter.ai/docs/api/api-reference/api-keys/create-keys)
- [Supabase: semantic search with pgvector](https://supabase.com/docs/guides/ai/semantic-search)
