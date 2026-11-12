# Hard synthetic scan comparison — 2026-11-11

No production model change is justified. This bounded challenge reveals distinct literal-sign, date-locale and response-format failures despite complete row coverage. It does not establish that degradation caused those failures: there is no paired clean control in this run.

## Scope and ground truth

Three built-in synthetic images contain 21 movements: a Spanish receipt (4), bilingual mixed-locale statement (5), and dense bilingual ledger (12). COP/USD, signed/unsigned values, DD/MM dates, excluded balances/totals, and debit/credit labels are explicit. Literal numeric sign is evaluated separately from ledger direction; an unsigned debit remains positive. Fixtures and each row are frozen in `scripts/eval/model-comparison/hard-scans-fixtures.ts`; model output never modifies expected values.

Before live dispatch, the evaluator opened and visually inspected all three generated PNGs on 2026-11-11, checking every reference, sign, amount, currency, date and direction against the fixture. All fields remained readable, with no clipped rows. This is agent visual inspection, not independent human validation. Deterministic Pillow 12.2.0 rendering uses Menlo 22 px, 1150×780 canvas, fixed skew 2.3°/-1.7°/1.1°, Gaussian blur 0.55/0.70/0.85 px, contrast 0.72/0.50/0.64. PNG SHA-256 values and complete synthetic ground truth are retained in the JSON artifact; images remain in `/tmp/spends-hard-synthetic-scans/` and can be regenerated. Font/Pillow changes may alter pixel hashes.

## Results

Source: [live synthetic evidence](2026-11-11-hard-scans-live.json). Each model received the same three images and extraction prompt once, temperature 0, 4096 output-token limit. No retries, fallback, plugins or production database access.

| Exact catalog model            | Exact rows | Correct literal sign | Correct date | Currency / direction / coverage | Strict / normalized schema | Duplicate / unexpected | Total cost USD | Mean latency ms |
| ------------------------------ | ---------: | -------------------: | -----------: | ------------------------------- | -------------------------- | ---------------------- | -------------: | --------------: |
| qwen/qwen3-vl-30b-a3b-instruct |      13/21 |                13/21 |        21/21 | 21/21 each                      | 3/3 / 3/3                  | 0 / 0                  |     0.00112485 |            8246 |
| mistralai/mistral-small-2603   |      13/21 |                13/21 |        21/21 | 21/21 each                      | 3/3 / 3/3                  | 0 / 0                  |     0.00122835 |            3268 |
| amazon/nova-2-lite-v1          |      16/21 |                21/21 |        16/21 | 21/21 each                      | 0/3 / 3/3                  | 0 / 0                  |     0.00306510 |            2340 |

Qwen and Mistral returned the absolute value of all eight printed negative amounts, although direction was correct. Nova preserved signs but interpreted five DD/MM dates as MM/DD on the mixed statement despite its explicit date heading. Nova returned a complete JSON Markdown fence in all three responses. Only that complete enclosing fence is normalized; surrounding prose, incomplete fences and malformed JSON are rejected. Strict schema results cannot be treated as normalized schema successes. Full document passes: Qwen 0/3, Mistral 0/3, Nova 2/3 after fence normalization.

## Cost, catalog and privacy

The catalog was fetched immediately before live dispatch from `https://openrouter.ai/api/v1/models`. Listed input/output USD per million tokens: Qwen 0.15/0.60, Mistral 0.15/0.60, Nova 0.30/2.50. Each call reserved 50,000 input plus 4096 output tokens at those prices. All nine were reserved before any dispatch: USD 0.1354656, below the additional USD 0.50 cap. Reported cost is complete for 9/9 calls and totals USD 0.0054183; there are no retry or plugin fees. The token reservation is a conservative estimate for these fixed 1150×780 images, not a provider-enforced account spend limit.

Every request used `provider.data_collection=deny` and catalog price maxima; this makes no ZDR claim. Inputs and saved output are synthetic only. Nova's USD 2.50/M completion price exceeds production vision caps of USD 1.00/M normally and USD 1.60/M when escalated (`src/ai/vision.ts:192`). The evaluation explicitly used the verified catalog cap; Nova is **not compatible with existing production price caps**. No production routing or caps were changed.

## Validation and interpretation

Focused tests cover literal-sign versus direction, duplicate references, full direction schema and complete-fence-only normalization. Tests, typecheck and file-scoped ESLint/Prettier were run; exact commands and results are reported to the reviewing parent agent. This is a three-document, single-repetition synthetic challenge, with no independent human ground-truth review, real-document performance claim, confidence interval, causality claim or declared winner. Next useful evidence is a paired clean/degraded repetition with explicit locale and literal-sign regression gates before any production routing proposal.

Reproduce locally (requires the existing Python/Pillow and Menlo installation):

```sh
node --experimental-strip-types --import ./scripts/eval/text-models/register.mjs scripts/eval/model-comparison/hard-scans.ts
# Inspect the three /tmp PNGs before the separate authorized live run.
node --experimental-strip-types --import ./scripts/eval/text-models/register.mjs scripts/eval/model-comparison/hard-scans.ts --live
```

A new `--live` invocation incurs a fresh reserved budget and overwrites the dated live artifact; do not rerun without preserving the original evidence and reconciling the remaining authorization budget.

## Additional raster PDF / actual OCR pathway

A separately authorized single call used `file-parser` with `pdf.engine=mistral-ocr` followed by the exact catalog route `deepseek/deepseek-v4.1-flash`. This is distinct from Mistral Small chat vision. The three inspected, SHA-verified degraded PNGs alone were wrapped in a three-page image-only PDF; `pdfinfo` confirmed 3 pages and `pdftotext` confirmed zero non-whitespace characters before dispatch. All three PDF renders were inspected and remained readable. No clean text or ground truth was passed to the downstream model. The PDF encoding uses JPEG quality 100, so the wrapped image pixels can differ slightly from the PNG pathway; this is another reason not to claim controlled OCR-only superiority.

[Raster PDF evidence](2026-11-11-hard-scans-plugin.json) records HTTP 200, finish `stop`, **21/21 exact rows, literal signs, dates, currencies and directions**, full coverage, zero duplicates/unexpected references, strict and normalized schema success, and 10,902 ms latency for the complete three-page request. That is one end-to-end OCR-plus-DeepSeek observation; intermediate OCR output was not retained, so extraction versus downstream reasoning cannot be attributed independently. The Mistral OCR engine version and exact underlying provider were not exposed or pinned. This is promising pathway evidence, not a winner or production release gate.

The immediately reverified catalog lists DeepSeek input/output at USD 0.022/0.40 per million tokens. The predispatch additional reservation was USD 0.0527384 (50k input, 4096 output, USD 0.05 conservative OCR allowance), bringing aggregate hard-challenge reservations to **USD 0.188204**, below the original USD 0.50 cap. The [official OpenRouter PDF announcement](https://openrouter.ai/blog/announcements/universal-pdf-support/) states USD 2/1000 pages for Mistral OCR. The returned `usage.cost` was USD 0.00680891, versus `cost_details.upstream_inference_cost` USD 0.00080891; the USD 0.006 difference matches three OCR pages. Aggregate reported cost including the nine image calls is **USD 0.01222721**. No retry was sent. The request retained `data_collection=deny` and verified catalog price maxima; no ZDR claim applies.

`hard-scans-plugin.ts` supports a local dry run that verifies the prior PNG hashes, creates the raster PDF, checks page count and absence of text, and renders inspection PNGs before a separate `--live` invocation. Final checks passed: 9 focused tests across hard-scans and comparison, `pnpm type-check`, scoped ESLint and scoped Prettier. Root-agent independent review remains the final assessment of these artifacts; production is unchanged.
