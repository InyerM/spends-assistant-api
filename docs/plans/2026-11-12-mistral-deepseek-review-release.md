# Mistral OCR + DeepSeek: review release

## Scope

The owner selected Mistral OCR with DeepSeek on 12 November 2026. This release implements an explicit optional extraction action for PDF statements and image receipts. It does not automatically switch existing extraction, post transactions, replay old documents, or deploy mobile changes. The accepted currency carousel remains in the web account-detail view.

The web server authenticates the owner, claims the private document, and prepares bounded single-page PDFs in an isolated worker. PDF pages remove annotations/actions and reject unexpected copied page/resource graphs; annotation-only content is intentionally excluded and the original remains available for review; images are canonicalized with bounded decoding and metadata removal. The Worker requires both the user's JWT and a server-only proxy secret, verifies every page hash before dispatch, rechecks OCR consent, reserves the daily budget atomically, and consumes one analysis allowance for the extraction action. Each page runs Mistral's file-parser with fixed DeepSeek V4.1 Flash. All pages must finish before owner/claim-scoped completion saves review observations and page provenance. No financial posting occurs.

Default extraction is preserved. Encrypted PDFs stay on the existing local password/text workflow; the OCR action never forwards passwords. Current OCR limits are five pages, one MiB per prepared page, five MiB original/total prepared bytes, 50 movements per page, and a 180-second provider deadline. Ambiguous or empty results remain review drafts. These resource bounds do not prove semantic completeness or protect the upstream OCR service from every compressed-resource workload.

## Privacy disclosure

New `document_ocr` consent is separate from text/image consents. The UI names OpenRouter, Mistral OCR and DeepSeek, explicitly discloses external document processing, and does not promise end-to-end zero retention. There is no synthetic policy-ack bypass.

Verified 12 November: [OpenRouter ZDR](https://openrouter.ai/docs/guides/features/zdr) covers inference routing, not plugins; account settings can also permit safety retention. [Mistral's privacy policy](https://legal.mistral.ai/terms/privacy-policy/) describes default API retention of 30 rolling days for abuse monitoring unless ZDR is activated. [Mistral's ZDR documentation](https://docs.mistral.ai/admin/monitor-comply/zero-data-retention) includes the OCR endpoint when enabled for the organization. These general policies do not establish a special OpenRouter–Mistral agreement or a region/retention guarantee for this plugin. The UI must retain the limitation rather than imply otherwise.

## Cost and authority

A page reserves 433,527 microUSD from the owner's daily ledger: the model's full 1,048,576-token context at the configured USD0.40/M input ceiling, 4,096 output tokens at USD1/M, plus USD0.01 for OCR. Actual total reported provider cost settles once; unknown costs and interrupted attempts remain conservatively reserved. This is an application spending guard based on bounded model/context and documented page billing, not a provider-enforced invoice cap. No automatic retries or Nova fallback are configured. A deployment should also use provider-level key spending limits.

The budget RPC serializes reservations by owner and day. Duplicate claims cannot dispatch again, and deleting a source document preserves spent budget. Settlement and extraction completion are service-role only. Authenticated clients cannot invoke those commands. Extraction completion rejects stale/foreign claims, incomplete provenance, and replacement of reviewed observations. Existing six-argument completion calls remain compatible through default parameters.

## Audit fixes included

- Authoritative owner/contact context and bounded description/notes retrieval; rule priority is stable and the first valid scalar assignment wins, while supported rule chaining remains.
- Rule prompt conditions now preserve executable AND/OR semantics and explicit category clearing.
- Safe AI failure metadata logs reason/status/model/duration and a correlation ID matching the usage event. No prompts, receipts, notes, responses or arbitrary exception messages are logged. Runtime log retention remains unchanged.
- Existing-transaction proposals retain their analyzed snapshot. A changed transaction requires reanalysis. Human edits survive reanalysis and a failed reanalysis retains the prior editable proposal without bypassing stale checks.
- Page evidence is visible in document review; safe budget/claim/availability errors have localized recovery messages.

## Configuration and rollout

Prepared migrations (not applied remotely):

1. `supabase/migrations/20261112000000_document_ocr_budget.sql` adds consent scope and private atomic budget ledger.
2. `supabase/migrations/20261112000010_document_ocr_provenance.sql` adds page provenance and compatible extraction completion.

Backend configuration:

- `DOCUMENT_PDF_OCR_ENABLED=true` only when testing/releasing the configured pathway.
- `DOCUMENT_PDF_OCR_PROXY_SECRET`: a new random server secret; share only with the web server, never a public/Next client variable.
- `DOCUMENT_PDF_OCR_DAILY_BUDGET_USD=5` is the recommended initial per-owner daily limit, configurable from greater than zero through 100.
- Existing OpenRouter and Supabase server credentials are reused without logging them.

Web server configuration uses the same enable flag and proxy secret, plus its existing `WORKER_URL`. Apply additive database migrations, release the backend with capability initially disabled, release the web, then enable the optional action and verify the consent/review flow. Preserve the original extraction path for rollback; disabling the flag stops new OCR dispatches without deleting saved drafts or history. Do not remove the new consent scope from responses while the released clients support it.

This work has not been deployed or applied to the production database. Native adaptation follows the web release under repository instructions. Do not represent a local UI fixture test as a real-user database extraction.

## Validation evidence

- Actual production OCR adapter, three immutable synthetic raster pages: 21/21 normalized amount/direction/currency/date/reference matches, no duplicate references. All output remains review-only. Reported cost USD0.009859715, three calls, no retries. See [release probe](../evaluations/2026-11-12-ocr-release.json); this is not a universal accuracy claim or a private-document test.
- Eight PGlite execution tests cover actual budget/provenance SQL, consent/ownership/claim rejection, permissions, conservative settlement, deletion retention, reviewed-observation protection and legacy completion compatibility: `tests/document-ocr-live-sql.test.ts`.
- PostgreSQL16 concurrency evidence: [parallel reservation result](../audits/2026-11-12-ocr-budget-concurrency.json). Two concurrent requests under a budget allowing only one produce one reservation and one denial. Only synthetic data was used; the ephemeral container is removed after the test.
- Final backend validation: **152 test files / 1,154 tests passed**, exit 0, 220.55 seconds, Node22.23.4 with two workers and explicit 15-second test/20-second hook timeouts. Typecheck, required lint/format commands and diff whitespace validation passed. Unrelated formatter-only deltas were restored from a snapshot of clean tracked files; existing work was preserved. Logs: `/tmp/anotto-release-2026-11-12/backend-{tests,typecheck,lint,format}.log`.
- Web validation: **286 files / 1,559 tests passed** on Node22. Final PDF resource-graph and UI-control follow-ups passed their focused suites, and a subsequent serial production build passed. Visual fixture verification is recorded in the web release plan; no public deployment or private-document inference was performed.

## Final local handoff

The ordinary final Anotto production build runs at `http://127.0.0.1:3107` without preload scripts or fixture bypasses. Login returned HTTP200. Browser-only intercepted synthetic document/consent responses verified acknowledgement, busy controls, budget-error recovery and page evidence at320/390/1440px with no horizontal overflow. Evidence is in the sibling web repository: `docs/audits/2026-11-12-ocr/visual-checks.json` and masked screenshots. The root independently inspected the320px document view and1440px provenance panel. This is responsive web validation, not native-iOS validation.

The new OCR action is deliberately unavailable for real-account extraction until the migrations and configured backend/web release are authorized and applied. The current app continues its previous extraction behavior. Native image dependencies were verified on the local macOS runtime and traced in the build; deployment must build/install the matching Linux platform dependencies.

Publication authorization was requested only after checks passed. No production database, provider-account settings, deployment, native build or financial records were changed in this implementation pass.
