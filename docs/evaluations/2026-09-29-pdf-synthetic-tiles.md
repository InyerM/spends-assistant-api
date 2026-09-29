# Synthetic statement: bounded dense-page tiling

Date: 2026-09-29 (America/Bogota). This is a **synthetic-only local benchmark**, not a PDF upload implementation. The [Qwen3 VL 30B whole-page run](2026-09-29-pdf-synthetic-qwen30b.md) timed out on the 15-row page. The [235B escalation run](2026-09-29-pdf-synthetic-qwen235b.md) returned 2,048 completion tokens, billed $0.003423 for that page, and failed as truncated. The full escalated run found 6 of 21 rows and billed $0.00489147. Those results motivate smaller image regions; they do not establish that tiling will succeed.

The new `--tile` mode sends only the fixed generated five-page statement. Page 4 is rendered into three 935-pixel-wide crops at 110 DPI; the other four pages remain whole. The crop positions are fixed in code and checked against Poppler word boxes so no synthetic row is partially cut. Each successful tile carries `pageNumber: 4`, `tileNumber`, and crop coordinates. Two intentional overlap references, `REF-405` and `REF-412`, are reported with both tile IDs. Matching duplicates are merged for the row score **and remain visible in the report**; conflicting, repeated within-tile, missing, out-of-tile, or truncated evidence fails.

Offline command: `npm run eval:pdf-synthetic -- --tile`. One local Node 22.17.0/Poppler 26.04.0 run rendered five pages and three crops in 367 ms. The fixed PDF was 3,656 bytes; the seven images that a live run would send totaled 271,215 bytes. Crops were 53,014, 59,872, and 30,924 bytes. The deterministic oracle reported 21/21 exact rows, 3/3 tiles accounted for, 0 false or wrong-tile rows, and both expected overlaps. This validates **rendering and scoring plumbing only**; no model was called and billed cost is unknown. A visual inspection of the middle crop before finalizing the boundary found a clipped row, so the crop was shortened; the word-box test now rejects such clipping.

Authorized next probe:

```sh
OR_API_KEY='your-key' npm run eval:pdf-synthetic -- --live --tile
```

The command makes seven synthetic Qwen3 VL 30B image requests: four whole pages and three dense-page tiles. Compare each tile's returned rows, timeout/truncation, tokens, cost, and latency with the two whole-page reports. A passing synthetic score requires 5/5 pages, 3/3 tiles, all 21 unique exact rows, zero false/wrong-page/wrong-tile rows, and no truncated request. Report overlap duplicates even on a pass. If any tile returns no usage, `totalCostComplete` stays false; do not infer total billed cost from `knownCostUsd`.

This fixture is text-only and uses one known layout; middle and lower crops lack the table header. A passing synthetic run would justify testing scanned and varied layouts in a separate consented benchmark, not shipping PDF upload. There is no schema or product route change. Provenance migration 70 and any future PDF migration 90+ remain separate.
