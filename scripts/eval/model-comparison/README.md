# Synthetic model comparison

Run from the backend root:

```sh
corepack pnpm exec vitest run tests/eval/model-comparison
node --experimental-strip-types --import ./scripts/eval/text-models/register.mjs scripts/eval/model-comparison/run.ts
node --experimental-strip-types --import ./scripts/eval/text-models/register.mjs scripts/eval/model-comparison/run.ts --live
```

Requires Poppler (`pdfinfo`, `pdftoppm`). The dry run verifies catalog availability and renders the immutable synthetic PDF without inference. Live mode privately loads `.env.local` and accepts `OR_API_KEY` or `OPENROUTER_API_KEY`. It sends only built-in fixtures; arbitrary files and model routes cannot be supplied.

Live output overwrites `docs/evaluations/2026-11-11-model-comparison-repeat.json`. Archive a result before another run. The original strict-parser baseline is preserved separately. No retries. Requests reserve 50,000 input tokens, 4,096 output tokens and $0.05 for the five-page OCR plugin before dispatch, with a $2 aggregate reservation ceiling per invocation. Prompt and completion price ceilings use the live catalog. This local guard is conservative for these fixed fixtures; it is not an account-level billing cap. The PDF plugin surcharge can have separate pricing. Report unknown costs explicitly.

Three image routes see identical five-page PNGs, one page per request. DeepSeek is the text intelligence baseline and the downstream chat model for a separate `file-parser`/`mistral-ocr` PDF route. The plugin is an OCR preprocessing service, not a chat model. Each model also receives three signed multicurrency rows as text and six synthetic intelligence cases in a single batch. Signed text performance does not establish signed image OCR quality.

Compare strict JSON separately from fence-normalized JSON. The production adapters currently parse strict JSON; this evaluation's normalization does not change production. Fidelity uses exact reference, amount (including sign), currency, and ISO date matching, plus row coverage and duplicates. Currency validation requires three uppercase letters; this is shape validation, not an exhaustive ISO currency registry. The forced fallback injects an invalid primary and calls Nova; it is an integration probe, not an observed production outage or evidence that fallback improves overall quality. Known synthetic coverage can gate fallback with a validator; production cannot assume ground-truth row counts.

The intelligence task uses English, explicit simplified context, and deterministic expected fields. It is not a replay of production prompts, Spanish conversational history, production rules, real contact resolution, or financial posting. No winner is declared from this sample.

## Spanish production review probe

With Node 22.23.4, run:

```sh
node --experimental-transform-types --import ./scripts/eval/text-models/register.mjs scripts/eval/model-comparison/spanish-review.ts --live
```

This imports the real `reviewCategory`, including its production prompt, normalization, strict JSON parser, retry policy and provider privacy/price constraints. It uses six fixed Spanish cases per DeepSeek V4.1 Flash, Mistral Small 2603 and **Nova Lite v1**. Nova 2 Lite is a distinct route whose catalog completion price exceeds the production cap, so it is recorded without sending a request. TypeScript parameter properties in the real OpenRouter client require transform mode; strip-only execution is insufficient.

The evaluation wraps inference fetch in this process only, reserves each retry using a conservative prompt byte bound plus output capacity at the production price ceilings, and refuses additional dispatches once $0.25 would be exceeded. No search tools are allowed. It retains source hashes, fixed synthetic cases, raw strict-JSON responses and normalized review output separately in `docs/evaluations/2026-11-11-spanish-review.json`. The rule case includes deterministic category forcing; inspect raw output separately rather than crediting that result entirely to model reasoning. This probe supplies authorized synthetic history directly and does not test database retrieval, real contact resolution or financial posting.
