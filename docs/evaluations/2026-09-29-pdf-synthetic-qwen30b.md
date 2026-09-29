# Five-page synthetic statement: Qwen3 VL 30B probe

Date: 2026-09-29 (America/Bogota). This run used only the built-in invented statement from `scripts/eval/pdf-statements/fixture.ts`. No bank record, production database row, or private image was sent. The local PDF was rendered into numbered PNG pages, and each page was sent separately through the current `extractImageObservations` adapter with `provider.data_collection: deny`. This setting does not guarantee zero retention.

Command: `npm run eval:pdf-synthetic -- --live`, with the OpenRouter key loaded from the local environment. The key and image content were not printed or saved. The harness exited with code 2 because the required coverage gate failed.

| Page | Expected rows | Returned observations | Result                                  | Billed cost returned |
| ---: | ------------: | --------------------: | --------------------------------------- | -------------------: |
|    1 |             2 |                     2 | Completed in 7.8 seconds                |          $0.00033285 |
|    2 |             2 |                     2 | Completed in 7.6 seconds                |          $0.00033885 |
|    3 |             0 |                     0 | Completed in 1.1 seconds                |          $0.00025080 |
|    4 |            15 |                     0 | Adapter failed at its 30-second timeout |              Unknown |
|    5 |             2 |                     2 | Completed in 3.3 seconds                |          $0.00029926 |

The score was **6 of 21 exact rows**, zero false rows and zero wrong-page rows among returned observations, and four of five pages accounted for. Known billed cost was **$0.00122176**, excluding the failed page because no usage/cost response was available. Thus total cost is unknown. The blank page still incurred model cost. The dense-page failure may reflect latency, output length, or model/provider behavior; the adapter hides upstream details by design, so this run alone cannot identify the cause.

This fails the PDF upload gate. Keep upload image-only. Next synthetic tests should compare an explicitly escalated model and bounded page regions with exact page provenance, preserve usage for failed attempts where the provider returns it, and exercise a scanned page. Any design must handle more than 50 rows without silent omission and work in the actual deployment runtime; the current Poppler-based harness establishes only local feasibility.
