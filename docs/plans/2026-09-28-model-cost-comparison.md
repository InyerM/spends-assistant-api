# Model cost comparison for Spends Assistant

Date: 2026-09-28. These are planning estimates, not invoices or a measured OCR benchmark. Prices and provider policies can change; check the selected endpoint before release.

## Comparable workload

- **1,000 single-image receipts or statement pages:** assume 2,000 billed input tokens per image, including its visual representation and prompt, plus 300 output tokens for extracted structured data. This totals 2 million input and 0.3 million output tokens. Actual image tokenization depends on resolution, cropping, provider, and model. A multi-page document counts as multiple pages.
- **1,000 text consultations:** assume 800 input and 250 output tokens each. This totals 0.8 million input and 0.25 million output tokens. Longer context, reasoning, retries, and multiple model passes increase cost.
- **1,000 dense statement pages:** as a sensitivity check, assume 10,000 input and 1,000 output tokens per page. This totals 10 million input and 1 million output tokens. A native PDF path may use different billing rules, so measure it separately.
- Estimates use the displayed standard OpenRouter rate, with no cache discount, batch discount, provider surcharge, taxes, storage, embeddings, or application hosting. USD amounts are rounded to cents. The calculation is `input_millions × input_rate + output_millions × output_rate`.

| Model                                                                                         | Input / output per million tokens | 1,000 images/pages | 1,000 text consultations | Intended role                                    |
| --------------------------------------------------------------------------------------------- | --------------------------------: | -----------------: | -----------------------: | ------------------------------------------------ |
| [Qwen3 VL 30B A3B Instruct](https://openrouter.ai/qwen/qwen3-vl-30b-a3b-instruct/performance) |                     $0.13 / $0.52 |             ~$0.42 |                   ~$0.23 | Low-cost image extraction candidate              |
| [Qwen3 VL 235B A22B Instruct](https://openrouter.ai/qwen/qwen3-vl-235b-a22b-instruct/pricing) |                     $0.20 / $0.88 |             ~$0.66 |                   ~$0.38 | Escalation for difficult images                  |
| [DeepSeek V4.1 Flash](https://openrouter.ai/deepseek/deepseek-v4.1-flash)                     |                     $0.13 / $0.52 |             ~$0.42 |                   ~$0.23 | Text generation and an image benchmark candidate |
| [GPT-5 Mini](https://openrouter.ai/openai/gpt-5-mini/)                                        |                     $0.25 / $2.00 |             ~$1.10 |                   ~$0.70 | Proprietary comparison candidate                 |
| [GPT-5.4 Mini](https://openrouter.ai/openai/gpt-5.4-mini)                                     |                     $0.75 / $4.50 |             ~$2.85 |                   ~$1.73 | Stronger proprietary comparison candidate        |
| [Claude Haiku 4.5](https://openrouter.ai/anthropic/claude-haiku-4.5/api)                      |                     $1.00 / $5.00 |             ~$3.50 |                   ~$2.05 | Proprietary comparison candidate                 |
| [Claude Sonnet 4.6](https://openrouter.ai/anthropic/claude-sonnet-4.6/pricing)                |                    $3.00 / $15.00 |            ~$10.50 |                   ~$6.15 | Expensive escalation or benchmark only           |

For **1,000 dense statement pages** under the stated token assumption, the same rates yield approximately $1.82 with Qwen3 VL 30B or DeepSeek V4.1 Flash, $2.88 with Qwen3 VL 235B, $4.50 with GPT-5 Mini, $12 with GPT-5.4 Mini, $15 with Claude Haiku 4.5, and $45 with Claude Sonnet 4.6.

Dedicated OCR is a separate option: [Mistral OCR 4.1](https://docs.mistral.ai/models/ocr-4-1) lists **$4 per 1,000 pages** or **$5 per 1,000 annotated pages**. [Mistral OCR 3](https://docs.mistral.ai/models/ocr-3-25-12) lists **$2 per 1,000 pages**. A second model pass to turn OCR text into transactions adds its own cost. These services need a separate API and privacy review.

At the assumed volume, 1,000 Qwen3 VL 30B image extractions plus 1,000 DeepSeek V4.1 Flash consultations cost approximately **$0.65 in model tokens**. This is a token-based estimate, not a guarantee that a user's entire monthly workload will remain under $10. Multi-page PDFs, high-resolution images, retries, complex reasoning, embeddings, and provider selection can increase the bill.

The successful synthetic Qwen3 VL 235B escalation used a provider priced above the table's lowest listed rate. Its request used 2,538 input and 319 output tokens and OpenRouter reported $0.00099164; the adapter allows up to $0.40/$1.60 per million tokens for this explicit escalation. See the [synthetic validation](../evaluations/2026-09-28-openrouter-synthetic.md).

## Selection and cost controls

1. Benchmark Qwen3 VL 30B, DeepSeek V4.1 Flash, GPT-5 Mini, and Claude Haiku 4.5 on the same private, redacted examples: single receipt, multiple receipts in one screenshot, SMS screenshot, noisy bank statement, and ambiguous Nequi text. Add Qwen3 VL 235B and Claude Sonnet only where cheaper models fail. Score field accuracy, missed movements, false movements, JSON validity, latency, and actual cost per accepted observation.
2. Route text requests with `provider.zdr: true` and `provider.data_collection: "deny"`. For Qwen3 VL image requests, use `provider.data_collection: "deny"` without ZDR: a live Qwen3 VL 30B request with ZDR returned HTTP 404 because no eligible endpoint was available, and the user explicitly permitted temporary provider retention while prohibiting training. [OpenRouter documents](https://openrouter.ai/docs/guides/get-started/sovereign-ai) these separate controls. Eligibility must be checked for each model/provider combination, and a provider policy may change. The [synthetic evaluation](../evaluations/2026-09-28-openrouter-synthetic.md) records the observed behavior.
3. Treat **$10 per user per month as a planning target only**. Collect privacy-safe model, token, and observed USD cost telemetry to compare real workloads with the estimate. Do not add a dollar-based request gate, reservation, or user-facing budget. Existing free-plan request counts remain a separate product policy; the current per-token price cap only filters provider pricing.
4. Keep a configurable task-to-model mapping and pin model/provider policy at execution time. Recheck rates and eligibility on deployment and periodically thereafter.
