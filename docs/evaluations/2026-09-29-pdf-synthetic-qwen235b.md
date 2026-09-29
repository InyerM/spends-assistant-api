# Synthetic dense statement page: Qwen3 VL 235B escalation

Date: 2026-09-29 (America/Bogota). The run used only the fixed invented five-page PDF from `scripts/eval/pdf-statements/fixture.ts`. Pages 1, 2, 3, and 5 used Qwen3 VL 30B; the 15-row page 4 used the explicit Qwen3 VL 235B escalation. The PDF was rendered locally into numbered images and no personal data or production record was sent.

Command: `npm run eval:pdf-synthetic -- --live --escalate`, with the OpenRouter key loaded from the local environment. The harness exited with code 2 because the quality gate failed.

| Page | Expected rows | Returned observations | Result                                                                      | Reported cost |
| ---: | ------------: | --------------------: | --------------------------------------------------------------------------- | ------------: |
|    1 |             2 |                     2 | Qwen 30B, 14.8 seconds                                                      |   $0.00059243 |
|    2 |             2 |                     2 | Qwen 30B, 3.3 seconds                                                       |   $0.00041740 |
|    3 |             0 |                     0 | Qwen 30B, 1.3 seconds                                                       |   $0.00016458 |
|    4 |            15 |                     0 | Qwen 235B, response truncated at 2,048 completion tokens after 50.3 seconds |   $0.00342300 |
|    5 |             2 |                     2 | Qwen 30B, 3.0 seconds                                                       |   $0.00029406 |

The full score was **6 of 21 exact rows**, four of five pages accounted for, and zero false or wrong-page rows among accepted observations. The provider returned usage and cost for the truncated page: 1,170 prompt tokens, 2,048 completion tokens, and $0.003423. Total reported billed cost was **$0.00489147**. Unlike the 30B baseline, all five requests returned cost data; no inference should be made about future provider prices from these two runs.

Escalation alone does not pass the PDF upload gate. The next synthetic experiment is fixed bounded regions on the dense page with page and region provenance, overlap checks, and explicit failure if any region is incomplete. Raising a token cap without proving complete row coverage would not meet the gate. The product stays image-only, and Poppler availability in the deployment runtime remains unverified.
