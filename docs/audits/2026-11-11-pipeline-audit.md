# Inbox pipeline audit — 11 November 2026

Latest delivery: [12 November OCR and audit release](../plans/2026-11-12-mistral-deepseek-review-release.md). Final backend suite now passes 1,154 tests; the historical counts below remain dated intermediate evidence.

## Final coordinated validation

The final frozen backend sources passed **149 files, 1,123 tests**, exit 0, in 168.54 seconds using Node 22.23.4 and `pnpm test:run --maxWorkers=2 --testTimeout=15000 --hookTimeout=20000`. This supersedes the intermediate counts below and includes ordered rule precedence, bounded notes retrieval, faithful rule serialization, and the isolated PDF OCR adapter sign-consistency regressions. Evidence: `/tmp/anotto-platform-audit/backend-overnight-release-check.log`. Repository `type-check`, `lint:fix`, and `format:fix` also passed; logs are `overnight-typecheck.log`, `overnight-lint.log`, and `overnight-format.log` in that directory. Final backend and web `git diff --check` passed. Unrelated formatter-only changes were restored from a pre-format snapshot of clean tracked files; pre-existing work was preserved.

The final web suite passed **283 files, 1,537 tests** and its production build passed. The local account-detail currency hero and visual verification are documented in the sibling web repository at `docs/audits/2026-11-11-existing-modules-ux-audit.md`. No deployment or native implementation occurred. The experimental OCR adapter is not imported by a production route; its activation gates remain in [the OCR design](../plans/2026-11-11-configurable-document-ocr-design.md). Hard-scan model results are in [the synthetic evaluation](../evaluations/2026-11-11-hard-scans.md).

After the authoritative contact-context follow-up, the complete backend suite passed: **147 files, 1,086 tests**, exit 0. Command: Node 22.23.4 `node node_modules/vitest/vitest.mjs run --maxWorkers=2 --testTimeout=15000 --hookTimeout=20000`. Runtime: 247.50 seconds. Evidence: `/tmp/anotto-platform-audit/backend-final-node22.log`. The larger integration-test time budget is explicit; no assertions or tests were removed to obtain this result. Earlier overloaded runs and their isolated reruns remain documented below.

The separate contact-context improvement and its independent review are documented in [the intelligence audit](2026-11-11-intelligence-context.md). No deployment or historical inbox replay has occurred.

## Scope and result

A conservative deterministic fast path now produces an editable inbox proposal when explicit event evidence, an owned active account, and an owned automation classification fully resolve a capture. No financial posting was added. Incomplete captures retain AI consent and quota enforcement. This is a scoped improvement, not a claim that every financial intake path is deterministic-first.

Evidence: `src/services/inbox-analysis.ts:38` and `src/utils/inbox-analysis-proposal.ts:167`; regression coverage in `tests/services/inbox-analysis.test.ts` and `tests/utils/inbox-analysis-proposal.test.ts`.

## Observed cause and change

Before this change, `processInboxAnalysisLease` required AI consent, reserved an AI parse, and invoked `suggestForwardedEmail` before calling the existing automation matcher in `buildInboxAnalysisProposal`. A capture already fully resolvable by explicit evidence and user rules therefore still depended on a model call.

The new order is: verify source and admissible message kind; read owned categories/accounts/rules; extract explicit evidence and evaluate existing rules; complete a fully resolved proposal; otherwise require AI consent, retrieve relevant history, reserve quota, request the model, and build the final editable proposal. The existing SQL lease completion remains the only persistence mechanism used here.

The fast path requires unambiguous amount, merchant, financial type, original date/time validated against the message, source suffix, owned active account, and either an owned rule category or a linked own transfer between accounts in the same currency. Missing time, ambiguous amounts, unresolved accounts, foreign categories, and cross-currency transfers fall back to the existing unresolved workflow. A matching rule alone cannot invent missing event facts. The deterministic branch does not require AI consent or consume AI quota because it makes no AI request. Forwarding verification remains mandatory before either branch.

The fast path also avoids loading history: a history-service failure cannot prevent a capture already resolved by rules. History is retrieved only in the permitted AI branch.

## Remaining work and strategy

- Existing proposal generation already checks active ownership and applies account-detection rules and unique suffix matching; this change reuses those checks instead of adding another account resolver.
- History remains model context, not an independently executable exact-match resolver. The supplied history shape contains description, notes, category and ID, with no explicit ownership field; a safe deterministic resolver would need documented relevance/recency/conflict rules and validated category linkage. It is not implemented here.
- Contact-specific resolution is not implemented in this inbox lease function. A contact name does not independently establish purchase purpose. Add an owner-scoped, explicit correction/contact mapping before introducing that fast path.
- Catalog-only resolution, incomplete-event deterministic completion, and field-by-field AI calls are not implemented. The unresolved branch still sends the bounded original message and current context to the existing model function. A next increment should resolve supported local fields first, then narrowly request unresolved classification/wording while retaining evidence validation.
- This change does not modify manual correction handling, owner SQL review authority, posting, consent storage, queue leases or mobile behavior. It does not deploy or replay historical jobs.

## Fifteen-day evidence and runtime correlation

The existing read-only Supabase summary covers `2026-10-28T02:53:57.929Z` through `2026-11-12T02:53:57.935Z` (`/tmp/anotto-platform-audit/telemetry-summary.json`). It contains 116 AI usage events: 111 succeeded and five failed. Four failures are `classify_forwarded_purchase` using DeepSeek V4.1 Flash (2 November twice, 7 November once, 11 November once); one is `extract_document` using Qwen3 VL 30B A3B (7 November). All five record one billed call. These counts describe operation telemetry, not all HTTP errors or semantic answer quality.

The same summary contains 74 inbox-analysis jobs, all skipped: 73 without an error and one with `invalid_source`. The latter is an intentional source-classification guard, not evidence of an upstream provider outage. There are no failed inbox-analysis jobs in this summary.

A read-only Cloudflare telemetry query was executed with existing local credentials, `dry: true`, and no saved query or configuration mutation. Three four-minute windows around retained failed operations returned the following sanitized evidence:

| Window (UTC)             | Returned runtime events | Relevant HTTP evidence                                                         |
| ------------------------ | ----------------------: | ------------------------------------------------------------------------------ |
| 7 Nov 00:30:44–00:34:44  |                       8 | Three `/merchant/suggest` requests returned 200, including 00:32:44.544        |
| 7 Nov 00:52:41–00:56:41  |                       7 | `/vision/extract` returned 502 at 00:54:41.460                                 |
| 11 Nov 22:55:00–22:59:00 |                       6 | Two `/merchant/suggest` requests returned 200 at 22:57:00.407 and 22:57:10.937 |

Private raw results are retained only in `/tmp/anotto-platform-audit/cf-nov*-private.json`; sanitized extraction is `/tmp/anotto-platform-audit/cf-sanitized-summary.json`. No credentials, bodies, capture addresses, user IDs or private document contents were copied into this report.

The merchant observations are consistent with graceful empty suggestions: `classifyForwardedPurchase` catches ordinary provider failures and returns null (`src/ai/forwarded-purchase-category.ts:77`), and the handler then responds 200 with a null category (`src/handlers/merchant-suggest.ts:47`). A 200 therefore does not prove a successful model response. Conversely, these failures do not prove the model returned a semantically wrong category; that would require an answer and trusted reference not retained in this telemetry.

The vision 502 correlates closely with the failed extraction event and is consistent with the handler's controlled upstream-failure response (`src/handlers/vision-extract.ts:82`). No provider exception detail was returned in the stored runtime events. Exact causes such as HTTP rate limiting, timeout, unavailable model, malformed response or output truncation cannot be distinguished retrospectively. They remain hypotheses, not findings. `AiUsageService` records status and usage totals without provider error/status codes (`src/services/supabase/ai-usage.service.ts:82`).

Cloudflare Workers Logs retention is at most seven days, so runtime evidence cannot reconstruct both 2 November failures within this fifteen-day Supabase window. Available logs also need not include a swallowed provider error. Source: [Workers Logs retention](https://developers.cloudflare.com/workers/observability/logs/workers-logs/). Query semantics and `dry` behavior: [Cloudflare telemetry query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/).

Recommended next observability increment: retain only a bounded error class, upstream HTTP status, operation, model, duration, and non-sensitive correlation ID; never retain prompts, images, bank message text or provider bodies. That instrumentation is not included in this scoped patch.

## Validation

Focused tests were added before implementation: the new resolver initially failed because it did not exist, and the service regression then failed with a null amount instead of the explicit amount. Additional review tests exposed the unnecessary history read and cross-currency fast-path acceptance before those were corrected.

Commands: `pnpm exec vitest run tests/services/inbox-analysis.test.ts tests/utils/inbox-analysis-proposal.test.ts`, `pnpm type-check`, `pnpm lint:fix`, `pnpm format:fix`, and `pnpm test:run`. The local shell requires `/Users/inyermarin/.nvm/versions/node/v22.17.0/bin/pnpm`. Focused tests and typecheck passed before the final repository checks; final consolidated check results are supplied by the coordinating agent. Logs are local under `/tmp/anotto-platform-audit/`.

Final controlled validation: `pnpm test:run --maxWorkers=2` completed 147 files / 1,080 tests in 263.26 seconds: 146 files and 1,079 tests passed; one existing SQL test hit Vitest's default 5,000 ms limit (`tests/account-balance-target-live-sql.test.ts:120`). There were no semantic assertion failures in that run. Running that unchanged file alone with `pnpm exec vitest run tests/account-balance-target-live-sql.test.ts --maxWorkers=1` passed all five tests in 5.39 seconds. The result supports resource-sensitive timeout behavior; it does not convert the full run into an all-green result. Evidence: `/tmp/anotto-platform-audit/backend-controlled.log` and `/tmp/anotto-platform-audit/backend-isolated-balance.log`. Final focused pipeline tests passed 17/17 and touched-file Prettier passed. Repository-wide formatting was executed as required, then unrelated formatting-only deltas were inspected and restored; no unrelated source edits remain from that command.

## Local follow-up: bounded failure diagnostics — 12 November 2026

`AiUsageService.track` now emits one structured runtime diagnostic when its tracked operation rejects. The diagnostic contains only operation, a model identifier restricted to 128 ASCII identifier characters, an allowlisted error class, an integer upstream HTTP status from 100–599 or null, duration clamped to 0–3,600,000 ms, and a generated correlation UUID. The UUID is reused as the existing usage-event ID. Error messages, stacks, arbitrary exception properties, prompts, images and provider response bodies are never included. Known provider classes are accepted only from `OpenRouterError`; other exceptions become `unknown`. Vision uses a typed subclass while preserving its existing controlled error messages. Merchant inference is already tracked before its graceful null fallback. Evidence: `src/services/supabase/ai-usage.service.ts:55`, `src/ai/vision.ts:4`, `src/ai/forwarded-purchase-category.ts:60`.

This adds runtime log correlation, not durable diagnostic columns or additional customer-data storage. Existing Workers retention and log availability still apply. A failed usage insert can leave a runtime correlation UUID without a stored row. Successful-but-abstaining merchant results, semantic quality, provider response bodies and individual retry diagnostics remain outside this bounded increment. There is no deployment, remote migration, OCR endpoint change or historical replay.

Tests were written and observed failing first: two service regressions failed because no diagnostic was emitted, then the vision regression failed because its HTTP exception lacked typed class/status. After implementation, the focused usage-service, vision and merchant suites passed 44 tests across three files. `node node_modules/typescript/bin/tsc --noEmit` and ESLint on both changed source files passed; Prettier was applied to the four changed TypeScript files. Privacy regression tests poison an exception message with private text and supply arbitrary exception properties and an overlong model, proving only the bounded metadata is emitted. Evidence: `tests/services/supabase/ai-usage.service.test.ts:101`, `tests/services/supabase/ai-usage.service.test.ts:124`, `tests/ai/vision.test.ts:103`. Full coordinated repository checks remain the parent audit's release gate.
