# Private credit card screenshot OCR evaluation

Date: 2026-09-29. Scope: five user-supplied 282 × 612 JPEG images (four CMR Falabella activity screens, one Lulo activity screen). Images and raw model responses remain outside Git. This is a small diagnostic sample, not a production accuracy estimate. No database or financial row was changed.

## Method

The local evaluator sent only these supplied images to OpenRouter with `provider.data_collection: deny` and `temperature: 0`. It compared the existing Qwen3 VL 30B extraction adapter with a private card-row prompt that retained signed amount _text_, visible date _text_, and row kind, then tried Qwen3 VL 235B on selected difficult screens. The billed cost values below are the provider's returned USD usage, not a quoted model price. Private response files were held under `/private/tmp` and were not committed.

## Findings

| Run                                         | Coverage                                                                                                                                       |           Returned usage cost | Observed problem                                                                                                                                                                                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing generic 30B adapter                | Three of five images passed its validator; two returned valid JSON but failed because card payments and purchases had negative numeric amounts | USD 0.00211269 for five calls | All accepted samples inferred USD from `$`; two invented 2023 dates for 2026 activity; some amounts lost decimal or grouping precision. Confidence values remained high despite errors.                                                         |
| Card-row 30B draft                          | Returned 5, 4, 4, 4, and 9 rows across the five images                                                                                         | USD 0.00152791 for five calls | Matching row counts concealed a missed insurance row and an invented “no more movements” row. It also mislabeled payments and a zero authorization in some images.                                                                              |
| Card-row 235B draft with explicit row rules | Returned 5 and 9 rows on the first CMR and Lulo images in a follow-up run                                                                      |  USD 0.00163462 for two calls | Signed amount strings, payment/insurance/fee kinds, and Lulo's zero authorization improved. A CMR insurance row with no visible date heading was still assigned the next row's date. This prompt was not tested on all five images or repeated. |

Local Apple Vision transcription found that two CMR images are near duplicates, but one pass missed a small interest amount that the other pass read. It also produced ambiguous amount punctuation in CMR. A text OCR layer alone does not establish financial semantics or safe deduplication.

## Product implications

1. Keep a signed `amount_text` and raw `date_label` in the extraction draft. Parse Colombian or US separators only with a provider-aware deterministic parser, retaining the original string for review. Do not infer COP or USD from `$` alone.
2. Give the reviewer an issuer/card selector and display image evidence next to each proposed row. Treat balances, limits, due dates, minimum payment, and “no more movements” as non-row context.
3. Classify purchases, card payments, insurance, interest, fees, and zero-value authorizations explicitly. A model confidence score alone cannot approve a financial write.
4. Group near-duplicate images and show candidate repeated rows once for review. Preserve the link to each source image. Do not silently collapse same-amount purchases.
5. The owner confirmed that the supplied 282 × 612 screenshots are the originals downloaded from Google Photos. Re-evaluate those available files with a labeled row set, two repeat runs, exact amount/date/kind checks, and returned cost per image before changing the released OCR path. Treat unreadable fields as uncertain; do not require the owner to find larger originals. A statement remains the reconciliation source for card balances.
