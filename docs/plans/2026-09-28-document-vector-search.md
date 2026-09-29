# Document vector search after the review inbox

Status: design only. The document inbox and deterministic reconciliation candidates
exist locally; the vector extension, embedding jobs, and semantic search are not
deployed or implemented.

## Boundary

Keep `documents.status` and `document_observations.status` as relational state.
Vectors represent the meaning of short extracted descriptions and counterparties;
they do not represent an extraction or review state. Exact amount, owner, account,
date, and reference checks remain mandatory for financial matching. Semantic
similarity can rank candidates or group ambiguous recurring recipients, but it
must never confirm a transaction or change balances by itself.

The current web suggestion route searches exact amounts with an optional date
window before ranking text hints. Add semantic retrieval only where a labeled
evaluation shows that it finds useful candidates missed by this baseline.
This order avoids paying for embeddings when a receipt already has a clear exact
match.

## Proposed storage and access

Use Supabase's `vector` extension in the `extensions` schema and a separate
`document_observation_embeddings` table with `observation_id`, `document_id`,
`user_id`, `model`, `content_hash`, `embedding extensions.vector(1024)`, and
timestamps. Give the table an owner-scoped composite foreign key to observations,
row level security, and no anonymous access. An owner-scoped search RPC must
filter by `auth.uid()` **inside** the SQL query. It should return IDs, distance,
and review state, never another user's vector or source text. Re-extraction
deletes old observations and their embeddings through the foreign key; changes
to the embedding model require a versioned reindex, not a mixed vector space.

For the initial number of personal documents, an exact vector scan with the
owner filter is simpler than an approximate index. Add HNSW with cosine distance
after measuring volume and query latency; filtered HNSW can otherwise return
fewer rows than requested. Keep the SQL search bounded by user and candidate
count. [Supabase semantic search](https://supabase.com/docs/guides/ai/semantic-search)
and [vector index guidance](https://supabase.com/docs/guides/ai/vector-indexes)
describe these behaviors.

## Embedding provider and privacy

`baai/bge-m3` is the first model to evaluate for Spanish financial descriptions:
OpenRouter lists 1,024 dimensions, multilingual retrieval, and $0.01 per million
input tokens. A synthetic 14-token request with `provider.data_collection: deny`
returned 1,024 values and reported $0.00000014; this verifies the API shape and
price observation, not retrieval quality or a provider retention guarantee.
Use only server-side calls, omit raw images, bank references, account numbers,
amounts, and full OCR excerpts from the embedding input, and record usage without
storing that input in telemetry. The existing OpenRouter privacy routing must be
verified for this endpoint before any real document is sent. [OpenRouter model
details](https://openrouter.ai/baai/bge-m3/providers) and [embedding API
reference](https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request)
support the model shape and endpoint. Supabase also documents local Edge Function
embeddings as an alternative if the external provider policy or quality is not
acceptable: [semantic search example](https://supabase.com/docs/guides/functions/examples/semantic-search).

## Acceptance before backfill

1. Evaluate consented or invented Spanish receipt, bank screenshot, and Nequi
   examples against the current exact candidate search. Measure candidate recall,
   false matches, latency, and observed cost. Do not tune a threshold on the same
   examples used to report accuracy.
2. Confirm that the embedding endpoint honors the required no-training routing;
   keep real-document embedding disabled until that check and owner-isolation
   tests pass.
3. Create the migration and a retryable, idempotent embedding job. A failed job
   leaves the extracted observation reviewable and can be retried without
   duplicating vectors or changing financial records.
4. Add private search and candidate ranking behind the current review flow.
   Confirmation still requires a separate, audited user decision and an atomic
   link to a transaction.
