# BGE-M3 synthetic document matching probe — 2026-09-29

## Scope and method

Eight invented Spanish cases cover receipts, bank screenshots, and Nequi
messages: four development and four holdout. Each case has two same-amount,
same-date transaction candidates; one case per split has no true match. The
candidate gate and baseline tie-breakers mirror the web code at
`lib/document-reconciliation.ts` and `app/api/documents/[id]/suggestions/route.ts`
as inspected on 2026-09-29. The embedding reranker preserves the exact-amount,
three-day date, and reference priority; BGE-M3 cosine similarity resolves only
ties after those checks. There is no threshold or automatic confirmation.

The holdout fixtures were written before the live request and were not edited
after seeing results. All provider inputs were invented short descriptions;
no personal records, amounts, dates, references, images, or full OCR excerpts
were sent. The request set `provider.data_collection` to `deny`. A successful
synthetic request does not prove which provider served it or establish a
retention guarantee for real documents.

## Observed run

Command: `pnpm eval:document-vectors --live` with `OPENROUTER_API_KEY` supplied
from the local ignored configuration at process start. No key was copied to or
stored in this worktree. One live run completed on 2026-09-29.

| Split                 | Ranking             | Known-match recall at 5 | Correct first suggestion | False first suggestions | No-match cases |
| --------------------- | ------------------- | ----------------------: | -----------------------: | ----------------------: | -------------: |
| Development (4 cases) | Exact/date baseline |                     3/3 |                      2/4 |                     2/4 |              1 |
| Development (4 cases) | BGE-M3 rerank       |                     3/3 |                      3/4 |                     1/4 |              1 |
| Holdout (4 cases)     | Exact/date baseline |                     3/3 |                      1/4 |                     3/4 |              1 |
| Holdout (4 cases)     | BGE-M3 rerank       |                     3/3 |                      3/4 |                     1/4 |              1 |

The remaining false first suggestion on each split is the deliberately
unmatched case. The model cannot safely infer that no transaction matches from
this ranking alone. Embeddings did not recover anything outside the existing
exact/date candidate gate, so the observed gain is top-one ordering only.

Eight provider requests took 6,158 ms in aggregate (770 ms mean). OpenRouter
returned 188 input tokens and USD 0.00000188 billed cost in all eight responses.
These are observed one-run values, not a per-user monthly forecast. There is no
product USD cap in this evaluation.

## Decision gate

Keep real-document embedding and pgvector disabled. The current proof is too
small and curated, and the unmatched cases still surface false first
suggestions. Before implementation, verify privacy routing for the embedding
endpoint and evaluate a larger consented labeled set with realistic same-value
payments, missing dates, noisy OCR, and counterparty aliases. Keep the exact
financial gate and explicit user confirmation.

Sources checked on 2026-09-29: [OpenRouter embeddings API](https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request)
for endpoint, request and response shape; [BGE-M3 model details](https://openrouter.ai/baai/bge-m3/providers)
for dimensionality; [OpenRouter data controls](https://openrouter.ai/docs/guides/features/zdr)
for the distinction between data collection and zero retention. The embedding
API reference lists a provider preferences object but does not document a
provider-specific retention result in the response.
