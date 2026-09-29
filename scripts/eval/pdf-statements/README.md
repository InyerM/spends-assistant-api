# Synthetic multi-page PDF statement benchmark

This local harness tests a fixed five-page PDF generated in memory. It contains 21 invented movements: two pages with repeated amounts, one empty page, one 15-row dense page, and a final page. It accepts no PDF path, so a personal statement cannot be sent accidentally. It does not upload, persist, or link documents or transactions.

## Requirements and commands

- Node 22 for the existing TypeScript loader.
- Poppler command-line tools `pdfinfo` and `pdftoppm`; tests also use `pdftotext`. On macOS: `brew install poppler`. The renderer is a **local benchmark dependency**, not a selected production renderer.

```sh
npm run eval:pdf-synthetic
npm run test:run -- tests/eval/pdf-statements/benchmark.test.ts
```

The default run renders each page at 110 DPI, binds the known page number before extraction, and scores a deterministic oracle. `modelValidated: false` and null token/cost fields mean this run proves only PDF generation, page separation, size limits, row attribution scoring, and report plumbing. The test suite also simulates a truncated model page and checks that the document fails the page-coverage gate and does not invent a total cost.

A live **synthetic-only** run uses the current `extractImageObservations` Qwen adapter, one request per page:

```sh
OR_API_KEY='your-key' npm run eval:pdf-synthetic -- --live
```

The adapter's existing provider controls apply (`data_collection: "deny"`, price ceilings, no ZDR). Never use this command for a personal PDF. The tool sends exactly the built-in five synthetic page images and prints page-level row counts, score, response time, tokens, and OpenRouter-reported cost when present. `knownCostUsd` sums reported costs; `totalCostComplete` is false when any page has no cost value or fails. A nonpassing live score exits with code 2. The harness does not print images, model prose, API keys, or raw provider errors.

A live result is still only a synthetic benchmark. It does not establish accuracy on scanned statements, handwriting, different bank layouts, deployment-runtime rendering, or provider privacy for real bank data. The release gate and schema coordination are in `docs/plans/2026-09-28-multipage-pdf-statement-gate.md`; provenance migration 70 is owned separately, and any PDF migration is reserved for 90 or later after benchmark review.
