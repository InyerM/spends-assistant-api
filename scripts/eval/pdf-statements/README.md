# Synthetic multi-page PDF statement benchmark

This local harness tests a fixed five-page PDF generated in memory. It contains 21 invented movements: two pages with repeated amounts, one empty page, one 15-row dense page, and a final page. It accepts no PDF path, so a personal statement cannot be sent accidentally. It does not upload, persist, or link documents or transactions.

## Requirements and commands

- Node 22 for the existing TypeScript loader.
- Poppler command-line tools `pdfinfo` and `pdftoppm`; tests also use `pdftotext`. On macOS: `brew install poppler`. The renderer is a **local benchmark dependency**, not a selected production renderer.

```sh
npm run eval:pdf-synthetic
npm run eval:pdf-synthetic -- --tile
npm run eval:pdf-synthetic -- --tile --focus-final
npm run test:run -- tests/eval/pdf-statements/benchmark.test.ts
npm run test:run -- tests/eval/pdf-statements/tiles.test.ts
```

The default run renders each page at 110 DPI, binds the known page number before extraction, and scores a deterministic oracle. `modelAttempted: false` and null token/cost fields mean this run proves only PDF generation, page separation, size limits, row attribution scoring, and report plumbing. The test suite also simulates a truncated model page and checks that the document fails the page-coverage gate and does not invent a total cost.

A live **synthetic-only** run uses the current `extractImageObservations` Qwen adapter, one request per page:

```sh
OR_API_KEY='your-key' npm run eval:pdf-synthetic -- --live
OR_API_KEY='your-key' npm run eval:pdf-synthetic -- --live --escalate
OR_API_KEY='your-key' npm run eval:pdf-synthetic -- --live --tile
OR_API_KEY='your-key' npm run eval:pdf-synthetic -- --live --tile --focus-final
```

The `--escalate` option uses Qwen3 VL 235B only for the 15-row page 4; the other four pages still use Qwen3 VL 30B. It is a new five-page run, so those four pages incur new requests. The adapter's existing provider controls apply (`data_collection: "deny"`, price ceilings, no ZDR); the escalated page uses its existing 60-second timeout. Never use this command for a personal PDF. The tool sends images derived only from the built-in synthetic PDF and prints page-level row counts, score, response time, tokens, and OpenRouter-reported cost when present. `modelAttempted: true` indicates a live attempt, not a passing quality result. `knownCostUsd` sums reported costs; `totalCostComplete` is false when any image call has no cost value. A nonpassing live score exits with code 2. The harness does not print images, model prose, API keys, or raw provider errors.

The `--tile` option is mutually exclusive with `--escalate`. It sends the four ordinary pages plus four fixed crops of dense page 4 (eight image requests in a live run), all using Qwen3 VL 30B. The crops overlap on synthetic references `REF-405`, `REF-409`, and `REF-412`. The report keeps page and tile IDs in `rowAttribution` and lists duplicate overlap evidence explicitly. A clipped, missing, or truncated tile, an out-of-tile row, or conflicting duplicate evidence fails the score. The crop boundaries are verified against the generated PDF's word boxes; middle and lower tiles do not contain the statement header. The offline tiled oracle checks only this plumbing, not model quality or cost.

`--focus-final` replaces whole page 5 with one bounded top crop containing both final rows, for eight images total. The summary records page and region attribution and requires every region to complete. This is a synthetic-only experiment; a single passing live run does not satisfy the repeatability gate. The [focused-crop report](../../../docs/evaluations/2026-09-29-pdf-synthetic-focused-live.md) records mixed live outcomes. PDF upload remains disabled.

A live result is still only a synthetic benchmark. It does not establish accuracy on scanned statements, handwriting, different bank layouts, deployment-runtime rendering, or provider privacy for real bank data. The release gate and schema coordination are in `docs/plans/2026-09-28-multipage-pdf-statement-gate.md`; provenance migration 70 is owned separately, and any PDF migration is reserved for 90 or later after benchmark review.
