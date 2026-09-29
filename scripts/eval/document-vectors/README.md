# Synthetic document vector evaluation

This harness compares the web document suggestion route's exact-amount and
three-day date candidate gate with a BGE-M3 reranking of **only those same
candidates**. All eight Spanish receipt, bank screenshot, and Nequi cases in
`fixtures.ts` are invented. The command accepts no input file or personal data.

```sh
pnpm eval:document-vectors
OPENROUTER_API_KEY=... pnpm eval:document-vectors --live
```

The first command runs the deterministic baseline without an API request. The
second requires an explicit `--live` flag and sends only the invented description
and counterparty strings to OpenRouter. It does not send amounts, dates,
references, account identifiers, images, or raw OCR text. Never place a key in
this directory or commit one. The request asks for `data_collection: deny`; it
does not assert that the embeddings endpoint offers zero retention.

The development and holdout examples are fixed before the live run. No
similarity threshold is tuned. `candidateRecallAt5` is the fraction of known
matches present in the filtered top five. `top1Correct` counts the first
suggestion equal to the known match. `falseTop1` counts a first suggestion that
is not the known match, including the case with no true match. These are
suggestions only: the harness never confirms or writes a transaction.

The live report includes request count, aggregate and mean request latency,
returned input tokens, and the sum of **returned** USD costs. If any response
omits a cost, the sum is `null` and `costComplete` is false; no list-price
estimate is substituted. The public [embedding API response schema](https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request)
documents tokens but does not promise a cost field. OpenRouter's [BGE-M3 model
page](https://openrouter.ai/baai/bge-m3/providers) lists 1,024 dimensions.

This is a tiny feasibility probe, not a release quality estimate. Real document
embeddings and pgvector remain disabled pending provider privacy verification,
owner-isolation tests, and a larger consented labeled benchmark.
