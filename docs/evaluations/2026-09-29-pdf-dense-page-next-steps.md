# Synthetic PDF dense-page follow-up

Date: 2026-09-29 (America/Bogota). This document describes the next **synthetic-only** test. It does not approve PDF upload or use of personal bank data.

The [Qwen3 VL 30B baseline report](2026-09-29-pdf-synthetic-qwen30b.md) on current main recorded four completed pages, 6 of 21 exact rows, and a timeout on the 15-row page 4 after about 30 seconds. Known billed cost was $0.00122176; the failed page had no cost response, so total billed cost remains unknown. The outcome does not distinguish latency from output-size or provider behavior.

This harness now supports a controlled comparison:

```sh
OR_API_KEY='your-key' npm run eval:pdf-synthetic -- --live --escalate
```

The command accepts only its generated five-page PDF. It reruns pages 1, 2, 3, and 5 on the existing Qwen3 VL 30B path, and sends only page 4 to the existing Qwen3 VL 235B escalation path (60-second timeout and its existing price ceiling). It prints `modelAttempted: true` and `densePageEscalated: true`; neither means the quality gate passed. The parent can run it with an authorized local key. No key was available in this worktree, so this comparison has not run here and no escalation cost is claimed.

Record page 4's returned model, row count, latency, tokens, billed cost, and error; then compare the full score with the baseline. The synthetic gate passes only with all five pages accounted for, all 21 exact rows matched, zero missed/false/wrong-page rows, and no truncation. A timeout, unknown page result, or partial row set fails. If OpenRouter returns usage before a truncated result, the harness retains it; if a request times out without a response, billed cost stays unknown.

If page 4 still fails, the next experiment is **deterministic, bounded tiling** of only that synthetic page. Define two or three fixed vertical regions with measured overlap, render each region separately, and label every extracted row with page 4 plus a tile index. Add tests that every expected reference appears in exactly one reconciled result, that overlap duplicates are flagged rather than silently discarded, and that missing/failed tiles block completion. Compare token cost and latency against both whole-page runs. This tiling remains a benchmark path until renderer behavior, scanned pages, and privacy are validated in the actual deployment runtime.

Keep the product image-only. No schema change is needed for this comparison; provenance migration 70 and any future PDF migration 90+ remain separate.
