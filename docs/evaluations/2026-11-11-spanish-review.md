# Spanish review using the real production adapter — 2026-11-11

Keep the existing production intelligence route. This bounded probe provides Spanish evidence using the real `reviewCategory` function rather than the earlier simplified English prompt; it does not establish a global model winner. [Sanitized artifact, fixtures and source hashes](2026-11-11-spanish-review.json).

## Method and spending

Six fixed Spanish cases were submitted independently to DeepSeek V4.1 Flash, Mistral Small 2603 and **Amazon Nova Lite v1**. Nova Lite v1 is a different model from Nova 2 Lite used in the earlier image benchmark. The real adapter supplied its production system prompt, user payload, deterministic rule/category normalization, strict JSON parsing and bounded retries. The source SHA-256 hashes are retained in the artifact. The fixture categories and history are invented and owner-consistent; no IDs or text came from customer records.

The harness intercepted inference fetch only in its own process to enforce a pre-dispatch reservation on every attempt, including retries. Production provider settings remained unchanged: `zdr=true`, `data_collection=deny`, maximum input/output price $0.40/$1.00 per million tokens, no search/tools. Each reservation used a conservative UTF-8 prompt-byte bound plus overhead and the requested output-token capacity. The ceiling was **$0.25**, with **$0.120664 reserved** across **30 dispatched attempts**. All attempts reported cost; **total observed cost was $0.002848321**. Production sources, tests, settings and financial data were not changed.

Nova 2 Lite was **not requested**: its verified catalog output price was $2.50 per million tokens, exceeding the production $1.00 completion price ceiling. This is a configuration compatibility limit, not a model quality result. [Catalog API](https://openrouter.ai/api/v1/models).

## Results

| Route                          | Complete fixture checks       | Category/kind | Notes expectations      | Named merchant/recipient retained | Attempts | Observed cost | End-to-end case latency range |
| ------------------------------ | ----------------------------- | ------------- | ----------------------- | --------------------------------- | -------- | ------------- | ----------------------------- |
| `deepseek/deepseek-v4.1-flash` | 6/6                           | 6/6           | 5/5 scored (4 explicit) | 6/6                               | 6        | $0.000922702  | 605–2,167 ms                  |
| `mistralai/mistral-small-2603` | 4/6                           | 6/6           | 5/5 scored (4 explicit) | 4/6                               | 6        | $0.000692499  | 1,116–1,557 ms                |
| `amazon/nova-lite-v1`          | 0/6 usable production results | unavailable   | unavailable             | unavailable                       | 18       | $0.001233120  | 4,061–5,077 ms                |

The six cases were a matching rule over conflicting restaurant history; a payment to an explicitly named recipient with synthetic contact-linked school history; explicit book/course notes overriding the café's usual purpose; an unidentified transfer requiring unknown kind/null category; a marketplace purchase without item details; and a medical consultation with separate annual-checkup notes. Full success requires the expected category and kind, unchanged explicit notes where scored, preservation of the named merchant/recipient and the supplied evidence ID where required. The ambiguous-transfer case has no exact notes expectation; a neutral uncertainty note is permitted. All fixtures/checks are in the JSON artifact and runner.

DeepSeek retained every tested title identity and explicit note. Mistral chose the expected categories and kinds but rewrote “Pago a Lina DEMO” as “Colegio,” losing the named recipient, and rewrote the café purchase as “Libros para curso,” losing the named merchant. Those two misses concern the fixture’s imposed name-retention check, not category errors. “Libros para curso” is a useful purpose-based title grounded in the current note, and “Colegio” can summarize the supplied purpose while omitting the recipient. Although the production prompt asks to preserve explicitly named merchants/recipients, name containment is not a universal measure of title quality; this probe does not establish that the alternate titles are unusable or that DeepSeek is superior overall. Both models preserved all four explicitly supplied notes, satisfied the separate empty-marketplace-notes check, and returned the required supplied contact-history evidence ID in 1/1 scored case. Both used Spanish explanations in this sample. These observations are supported by `results[].value` and raw strict JSON in `attempts[].raw`.

Nova Lite v1 returned HTTP 200 and usage on all 18 attempts, but every attempt failed strict JSON parsing. The unchanged production recovery logic tried three times for each case and then failed the review. No alternative parsing or response repair was applied. This establishes a production-format failure in this configuration, not poor category reasoning. Unparseable content was not retained, so this artifact does **not** establish whether Markdown fences or another format caused the failure. The earlier Nova 2 Lite fence-normalization finding is separate and must not be attributed automatically to Nova Lite v1.

## Interpretation and limits

The rule case is partly deterministic: `reviewCategory` can force the supplied valid category rule after inference and replace its explanation. Both DeepSeek and Mistral also selected that category in their raw JSON here; the normalized success rate alone should not be credited solely to model reasoning. Marketplace fallback is also part of the real normalization. The artifact retains raw and normalized results separately for this reason.

Synthetic contact-linked history was supplied directly to the adapter. This probe does not test SQL retrieval, same-name contact resolution, owner validation or the new server context lookup. The separate local PostgreSQL/PostgREST integration covers that lookup. The school-payment case also includes an explicit current school-purpose note, so it cannot isolate the causal contribution of contact history. There was one repetition, one small catalog and no noisy receipts, private data, adversarial text or financial posting. Exact notes equality and name containment are conservative checks, not a complete semantic evaluation of descriptions or explanation quality.

Recommended next step: keep the current route, expand Spanish cases that require history to resolve purpose, add conflicting/insufficient evidence and double-name contacts through the authoritative retrieval service, and measure context recall plus title/notes preservation before revisiting model selection. Nova candidates need an explicitly tested production JSON contract or documented normalization policy before adoption; no provider/privacy/price constraints were relaxed in this probe.

Reproduce with Node 22.23.4:

```sh
node --experimental-transform-types --import ./scripts/eval/text-models/register.mjs scripts/eval/model-comparison/spanish-review.ts --live
```

Typecheck, scoped ESLint, formatting and `git diff --check` passed for the evaluation addition. No tests were added or edited while the final backend suite ran.
