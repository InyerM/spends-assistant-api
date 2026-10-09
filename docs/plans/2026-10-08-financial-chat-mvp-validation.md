# Read-only financial chat MVP validation

Local implementation date: 2026-10-08. Not deployed.

## Contract

`POST /financial/chat` accepts `question` (1–2000 characters), `month` (`YYYY-MM`), and an explicit `corpusAcknowledged: true`. Authentication resolves the owner server-side. Current `financial_text` consent is required before corpus access, followed by an atomic reservation against the existing monthly AI request quota.

Three fixed owner-scoped read tools fetch at most 100 monthly non-deleted transactions without duplicate flags, 50 current active accounts, and 20 extracted, unarchived document metadata records. A one-row overflow probe exposes truncation. The request is rejected before inference if the serialized source snapshot exceeds 64,000 characters. Document text, filenames, file paths, extraction payloads, email bodies, and raw transaction text are excluded. No financial records are written.

Sources are linked through server-constructed `/transactions/{id}`, `/accounts/{id}`, and `/documents/{id}` paths. Model-provided links and unknown citations are rejected. Numerical literals must occur in the cited amount, balance, or date fields; this intentionally rejects unsupported derived totals. This guard does not establish semantic correctness, category interpretation, currency consistency, or completeness. The UI asks the owner to verify figures against the source records.

The model is fixed to `openai/gpt-4.1-nano`. The existing adapter applies `provider.zdr: true`, `provider.data_collection: "deny"`, a bounded output, timeout and bounded retry. Private usage telemetry records operation/model/token/cost metadata; questions, sources and answers are never logged or persisted by this feature. The UI keeps only the current question and answer in memory and allows clearing it.

## Evidence

Focused backend tests cover authentication, corpus acknowledgement, financial-text consent before retrieval, quota before retrieval/inference, invalid inputs, owner-scoped bounds, archived/deleted/duplicate exclusions, year-boundary dates, routing privacy flags, private telemetry, unknown citations, unsupported numbers, source links and an explicit investment recommendation pattern. Web tests cover the composer acknowledgement gate and authenticated proxy field allowlisting, cookie-origin protection, quota status and upstream error redaction.

Provider facts checked against official OpenRouter pages on 2026-10-08:

- [GPT-4.1 Nano](https://openrouter.ai/openai/gpt-4.1-nano): listed input/output prices are USD 0.10/0.40 per million tokens. Effective costs depend on actual usage and provider routing; no USD 10 billing cutoff is implemented.
- [Zero Data Retention](https://openrouter.ai/docs/guides/features/zdr): per-request `provider.zdr: true` restricts eligible inference endpoints. Provider availability has not been tested with a live personal-data request.
- [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection): `data_collection: "deny"` excludes providers that collect user data according to OpenRouter's provider classifications.

## Remaining release gates

- Run the integrated web production build and full repository checks after cherry-picking the isolated branches.
- Evaluate real model accuracy and prompt-injection resistance against a synthetic suite before deployment. Current tests stub inference and prove application guards, not model compliance.
- No arbitrary tools or SQL, full-corpus search, historical balances, budget status, loan schedules, investment analysis, approved document excerpts, FX conversion, saved history, or financial actions are provided in this MVP.
- The investment prompt and output pattern are defense in depth; they are not a legal review or a complete classifier of personalized securities advice.
