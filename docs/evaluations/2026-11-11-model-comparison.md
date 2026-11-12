# OpenRouter synthetic comparison — 2026-11-11

No production winner is established. Keep the current Qwen image and DeepSeek intelligence routes while expanding the benchmark. Nova is a promising image candidate after explicit JSON fence normalization; the current strict production parser would reject its observed responses. Mistral OCR is a viable separate PDF preprocessing candidate, with a distinct cost and privacy review before production adoption.

## Evidence and reproducibility

- [First run: strict parser](2026-11-11-model-comparison.json): 25 requests, reported cost **$0.01904436**.
- [Repeat: strict and normalized JSON](2026-11-11-model-comparison-repeat.json): 25 requests, reported cost **$0.01884136**.
- **Total reported cost: $0.03788572**, all 50 attempts have reported usage costs. Each run reserved at most **$0.39954160** using catalog token prices, bounded output and a conservative OCR allowance; combined reservation **$0.79908320**, below the authorized $2 ceiling.
- [Runner and instructions](../../scripts/eval/model-comparison/README.md); [scoring/fallback tests](../../tests/eval/model-comparison/comparison.test.ts).

Both JSON artifacts retain only built-in synthetic outputs, route metadata, metrics and live catalog snapshots. Credentials and upstream error bodies are excluded. Data collection was denied in routing. ZDR was not requested or verified, and these results do not authorize sending personal documents.

The catalog returned all four exact route IDs in both runs. Prices per million tokens were Mistral Small 2603 $0.15/$0.60 input/output, Nova 2 Lite $0.30/$2.50, Qwen3 VL 30B $0.15/$0.60, and DeepSeek V4.1 Flash $0.022/$0.40. These are catalog snapshots, not stable price promises; usage costs are the billing evidence. [Live catalog API](https://openrouter.ai/api/v1/models).

## Image extraction and PDF preprocessing

Three chat vision models received the same five separately rendered synthetic PDF pages: 21 rows, one blank page, repeated amounts and a dense 15-row page. Match requires exact reference, numeric amount including sign, currency and date, with no duplicate or extra rows. The repeat results below come directly from each artifact's `records[].score`; latency and cost include inference only, excluding local PDF rendering.

| Route                                                     | Exact rows, first / repeat                         | Repeat page coverage                        | Repeat strict JSON  | Repeat page latency median / max | Repeat cost, five pages |
| --------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------- | ------------------- | -------------------------------- | ----------------------- |
| `mistralai/mistral-small-2603` chat image                 | 19/21 / 19/21                                      | 5/5, all rows returned                      | 5/5                 | 1,507 / 3,847 ms                 | $0.00174585             |
| `amazon/nova-2-lite-v1` chat image                        | unavailable under strict parser / 21/21 normalized | 5/5 normalized                              | 0/5; normalized 5/5 | 1,291 / 3,165 ms                 | $0.00279150             |
| `qwen/qwen3-vl-30b-a3b-instruct` chat image               | 21/21 / 21/21                                      | 5/5                                         | 5/5                 | 1,783 / 10,225 ms                | $0.00140970             |
| `mistral-ocr` PDF plugin → `deepseek/deepseek-v4.1-flash` | 21/21 / 21/21                                      | full PDF submitted; page binding not scored | 1/1                 | 5,022 ms whole PDF               | $0.010341652            |

Mistral changed printed unsigned positive amounts for debit references `REF-201` and `REF-501` into negative values in both runs, despite the instruction to preserve printed numeric signs. Currency and dates were correct on every returned row. This evaluates literal transcription, not financial ledger sign semantics. Other fixture rows also say debit, so behavior was inconsistent across rows. The source PDF intentionally prints unsigned numbers. Signed multicurrency image OCR was **not** tested.

Nova's first run failures were JSON format failures, not demonstrated OCR failures. The repeat's only normalization removes a whole-response Markdown fence before JSON parsing; every Nova image response required it, and all 21 rows then matched. No attempt was made to repair arbitrary malformed JSON. Production `src/ai/vision.ts` currently uses strict `JSON.parse`; no production code was changed.

The `mistral-ocr` route is OpenRouter's `file-parser` plugin with `pdf.engine=mistral-ocr`, followed by DeepSeek chat extraction. It is **not** the Mistral chat model and does not establish standalone OCR accuracy independently of DeepSeek. Its roughly $0.01034 cost includes the reported plugin/chat usage; no separate component billing breakdown was returned. OpenRouter documents the plugin as a PDF preprocessing engine with separate page charges and potential extracted-image forwarding. [PDF plugin documentation](https://openrouter.ai/docs/guides/overview/multimodal/pdfs).

## Text fidelity and intelligence

All four routes reproduced all three signed text rows in the normalized repeat: negative and positive COP decimal amounts, a negative USD decimal amount, and differing ISO dates. This is a structured text retention check, not evidence about scanned receipts, locale number parsing or noisy OCR. Mistral, Qwen and DeepSeek also passed that strict check in the first run; Nova required fence normalization.

Each intelligence request batched six independent synthetic cases: explicit rule over history, confirmed history, ambiguous same-name contacts, known contact rule, missing evidence, and separate description/notes. Exact expected fields are scored; generated prose is not judged semantically.

| Route               | First / repeat correct cases        | Repeat strict JSON | Repeat latency | Repeat reported cost |
| ------------------- | ----------------------------------- | ------------------ | -------------- | -------------------- |
| Mistral Small 2603  | 4/6 / 4/6                           | yes                | 1,674 ms       | $0.00018390          |
| Nova 2 Lite         | unavailable strict / 5/6 normalized | no                 | 1,330 ms       | $0.00078880          |
| Qwen3 VL 30B        | 4/6 / 4/6                           | yes                | 4,552 ms       | $0.00017700          |
| DeepSeek V4.1 Flash | 6/6 / 6/6                           | yes                | 16,020 ms      | $0.000317514         |

Mistral and Qwen failed the known-contact and description/notes cases in both runs. Nova failed description/notes in the normalized repeat. DeepSeek passed all six twice. These English prompts provide short explicit context; they do not reproduce production prompts, Spanish conversation, real rule conflict resolution, retrieved history, financial review or financial posting. Two repeats on the same six cases cannot establish broad reliability.

## Fallback validation

The live integration probe injects an invalid primary response, then calls Nova on signed synthetic text. The original strict-parser probe failed to produce parsed data; the normalized repeat returned all 3/3 rows correctly. This establishes that the secondary route can run after a forced failure, not that a naturally failing Mistral response was recovered, nor that fallback optimizes production cost or quality.

Offline tests additionally cover transport failure, malformed schema, invalid dates/currency shapes, missing and duplicate rows, preserving a valid primary, and a caller-supplied completeness validator. The final harness records both fallback use and secondary acceptance. Production cannot assume the ground-truth row count available to this synthetic validator. Empty rows are legitimate for the blank page; completeness requires source context rather than a blanket nonempty rule.

## Validation and remaining limits

Focused evaluation tests passed (71 before the two additional validation/parser cases; six new comparison tests passed after those changes). Typecheck and targeted ESLint passed. Required repository lint/format commands ran; unrelated formatter-only changes were removed. An overlapping full backend test run encountered SQL setup failures and is not counted as passing; the root agent owns final consolidated validation.

The sample uses one font, clean generated pages, COP-only unsigned image amounts, no rotations, handwriting, low-quality photos, multilingual receipts or adversarial document text. Timing was measured on a shared busy machine and provider routes were not pinned; do not infer latency percentiles beyond this sample. The two parser versions are intentionally not equivalent for Nova, so its first strict failure rate is kept separate. No deployment, production model switch or financial mutation was performed.

Next benchmark: add signed and multicurrency scanned fixtures, several receipt layouts and Spanish production-shaped intelligence cases; validate fence handling and schema contracts before considering Nova as a production fallback. Keep review/posting separation and owner-scoped SQL authority unchanged.

## Spanish production-adapter follow-up

A subsequent bounded Spanish probe uses the real production `reviewCategory` prompt, normalization, strict parsing and privacy/price settings: [report](2026-11-11-spanish-review.md), [sanitized artifact](2026-11-11-spanish-review.json). It spent an additional $0.002848321 with $0.120664 reserved under a separate $0.25 limit. Both DeepSeek and Mistral chose all six expected categories/kinds and preserved the four explicit notes. DeepSeek satisfied all six fixture checks; Mistral missed the fixture’s name-containment check twice while producing purpose-based titles, which does not establish a universal quality disadvantage. Nova Lite v1 failed the production strict JSON contract on all six cases after bounded retries; Nova 2 Lite was not requested because its catalog output price exceeds the current production cap. These are distinct Nova routes and distinct evidence from the earlier image probe. No production model was changed.
