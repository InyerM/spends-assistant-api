# Synthetic multi-page PDF feasibility run

Date: 2026-09-28 (America/Bogota). Mode: **offline synthetic oracle**. No OpenRouter key was present in the worktree environment, so no model request was sent and model accuracy or billed cost was not measured.

Command: `NODE_NO_WARNINGS=1 npm run eval:pdf-synthetic`. Environment: Node 22.17.0 and Poppler 26.04.0 on the local macOS host. The fixed PDF is generated in memory by `scripts/eval/pdf-statements/fixture.ts` and is not a bank record. `pdfinfo` confirmed five letter-sized pages; `pdftotext` confirmed all 15 dense-page references on page 4; the harness rendered each page separately to PNG. A visual inspection of page 4 showed readable rows.

| Measure                    |                       Local result | Meaning                                                                 |
| -------------------------- | ---------------------------------: | ----------------------------------------------------------------------- |
| PDF size                   |                        3,656 bytes | Fixed text PDF fixture only                                             |
| Pages                      |                                  5 | Pages 1–2 and 5 have two rows each; page 3 is empty; page 4 has 15 rows |
| Combined rendered PNG size |                      258,223 bytes | 110 DPI; largest page 130,818 bytes                                     |
| Render duration            |                             379 ms | One local run; no p95 claim                                             |
| Oracle row attribution     | 21/21 exact; 0 wrong-page; 0 false | Scoring and page-binding plumbing only, not OCR quality                 |
| Model tokens and cost      |                            Unknown | `modelValidated: false`; no provider call                               |

Tests in `tests/eval/pdf-statements/benchmark.test.ts` additionally reject arbitrary PDF bytes, verify every reference is on its expected PDF page, detect a cross-page false row, fail closed on a simulated truncated page, and retain known billed usage when a truncated response supplies it. The live `--live` mode uses the existing image adapter and will report actual provider usage only when a key is explicitly supplied; it has not run here.

This result does **not** pass the PDF upload release gate. It does not establish Qwen extraction quality, full-page coverage on real statements, scanned-page OCR, privacy eligibility for real data, or deployment-runtime rendering. The current product remains image-only. The implementation gate is in `docs/plans/2026-09-28-multipage-pdf-statement-gate.md`.
