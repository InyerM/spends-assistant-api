# Multi-page PDF bank statement: implementation and benchmark gate

Status: design only. Do not expose PDF upload in the web UI until the gates below pass. No production statement was uploaded or sent to a provider during this review.

## Current boundary

- The web upload accepts only PNG, JPEG, and WebP up to 5 MiB (`spends-assistant-web/lib/documents.ts`, `app/api/documents/route.ts`, and `app/(dashboard)/documents/page.tsx`). Its extraction route sends one image data URL to the Worker and expects up to 50 observations (`app/api/documents/[id]/extract/route.ts`).
- The Worker `/vision/extract` endpoint accepts one image data URL, not a PDF (`src/handlers/vision-extract.ts`). Its Qwen adapter uses `provider.data_collection: "deny"`, does not require ZDR, and has a 2,048-token output cap (`src/ai/vision.ts`). A prior synthetic image test is not a statement-page benchmark (`docs/evaluations/2026-09-28-openrouter-synthetic.md`).
- The private `documents` Storage bucket and table permit image MIME types only; `document_observations` has an ordinal and excerpt but no page or region field (`supabase/migrations/20260929000010_document_inbox.sql`). Migration `20260929000060_document_confirmation.sql` governs reviewed links and must remain untouched.

## Provider findings (checked 2026-09-28)

[OpenRouter's PDF guide](https://openrouter.ai/docs/guides/overview/multimodal/pdfs) says a PDF can be sent by base64 data URL or public URL. The latter would expose a private bank statement and is out of scope. A non-native model receives a parsed result from the `file-parser` plugin; native PDF support must be established for the chosen model and endpoint. The current Qwen image request is not a PDF contract.

The guide documents Cloudflare AI conversion to markdown and Mistral OCR as alternate parsers. It documents at most eight forwarded images for Mistral OCR, with surplus images dropped, and file annotations containing text/image parts but no documented page number. Therefore neither route currently proves every page and row can be attributed to a specific page. The Cloudflare path may be free for parsing, while inference still costs tokens; the Mistral path incurs per-page OCR charges. These are not measured costs for this application's statement workload.

[OpenRouter's ZDR documentation](https://openrouter.ai/docs/guides/features/zdr) states that ZDR routing applies to inference providers, not third-party plugins or tools. [Its privacy policy](https://openrouter.ai/privacy/) distinguishes request inputs from files uploaded through the persistent Files API and says providers have their own terms. The persistent Files API should not be used for this workflow. The previous synthetic test found no ZDR-eligible Qwen route and used `data_collection: "deny"` only; that setting does not promise zero retention. Provider eligibility and retention must be checked again before any real statement test.

## Recommended implementation path after validation

1. Keep the original PDF in private Supabase Storage under the owner's prefix. Reject encrypted, malformed, executable, or over-limit PDFs before persistence. Initial limits: at most 5 MiB, 2–5 pages, and at most 50 candidate movements in total; reject overflow explicitly. Determine page count with a real PDF parser, never by regex over bytes. Do not expand the current image route or claim it accepts PDFs.
2. Prefer **local, deterministic page rendering** to bounded images in the web/backend runtime, then send one numbered page image per request through an image extraction adapter. This avoids handing the whole PDF to OpenRouter's file-parser plugin and assigns a trustworthy page index before model inference. Verify that the renderer works in the actual deployment runtime, has bounded memory/time, does not fetch embedded resources, and handles scanned and text PDFs. Do not select a renderer solely from a Node test.
3. Inspect the document provenance migration `20260929000070` before changing the schema. A PDF migration numbered `20260929000090` or later should allow PDF MIME in the existing private bucket/table, add `page_count` and any PDF-specific provenance fields not already supplied by migration 70, and add durable per-page extraction state. Its PDF observations require a 1-based page number and optional bounded region. Owner and claim-token checks must prevent one user's page results from being attached to another document. Reviewed observations must remain immutable under migration 60's review rules.
4. Process pages as a bounded job, not a single web request. Persist each page's result and usage under an owner-scoped claim. Merge only when all expected pages have succeeded and every observation has page evidence; mark partial failure visibly and retain retryable page state. Never silently truncate at the current 50-observation RPC limit or the model output limit. The current image endpoint can be reused only after its page-density benchmark passes; it must not be relabeled as PDF parsing.
5. Show page number, source excerpt, amount, date, and confidence for each draft and a link to the private source page during review. Extraction and review may link to an **existing** transaction through the audited decision RPC; they must never create or modify a transaction or account balance.

## Benchmark before implementation or real-data rollout

Use locally generated PDFs with known line items first: 2, 5, and 6 pages; text and scanned pages; repeated headers; multi-column tables; page-break rows; debit/credit signs; fee and transfer rows; blank pages; malformed/password-protected PDFs; and >50 movements. Keep fixtures synthetic and in the repository only if they contain no personal data. For each page, record expected row IDs, exact amount/date/currency, and expected page. Run both local-page-rendering plus the image adapter and a separate OpenRouter parser probe only with synthetic PDFs. Do not send private statements to the parser plugin during this gate.

Measure page coverage, row recall, false movements, amount/date/sign accuracy, page attribution, JSON validity, truncation, p50/p95 latency, peak memory, and **billed** cost per page and per accepted observation (including retries/OCR). Inspect provider routing and privacy for the exact chosen endpoint on the test date. Pin a per-request price limit and a per-document budget before any live trial. A passing synthetic gate requires every page accounted for, no silent omission or wrong page, zero false financial rows, and no incorrect high-confidence amount/sign. Any missing page, truncated model response, or unverified attribution fails closed into an explicit review/error state.

Only after that gate, request a separately consented, redacted bank-statement set. Recheck provider/plugin terms with the user before sending it. Compare results to manually labeled rows; set a measured cost and reliability threshold from that dataset. Until then, keep the image-only upload UI unchanged.

## Implementation tests to write first

- Upload rejects non-PDF bytes, encryption, >5 MiB, >5 pages, and client MIME spoofing; owner-only path and private bucket policies hold.
- Each page claim is unique and replay-safe; a late result cannot overwrite a newer claim. A failed or empty page blocks document completion, and 51 observations return an error rather than truncating.
- Every PDF observation has an in-range page number and excerpt; an observation from another owner/document fails. A re-extraction cannot erase a reviewed observation or decision.
- Rendering has fixed limits for dimensions, memory, and runtime; synthetic pages with repeated headers and page breaks retain correct page indices.
- The review UI cannot confirm an unattributed row and never calls transaction creation or account mutation APIs.
