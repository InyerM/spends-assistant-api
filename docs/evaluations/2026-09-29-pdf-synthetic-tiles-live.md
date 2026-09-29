# Synthetic statement: live tiled Qwen3 VL 30B probes

Date: 2026-09-29 (America/Bogota). Both runs used only the fixed invented five-page PDF. Page 4 was rendered into three numbered, overlapping regions; pages 1, 2, 3, and 5 remained whole. Seven synthetic images were sent to the existing Qwen3 VL 30B adapter in each run. No personal document or production row was involved.

Command: `npm run eval:pdf-synthetic -- --live --tile`, with the OpenRouter key loaded from the local environment. Both runs exited with code 2 because the complete-document gate failed.

| Measure                       | Run 1                                                                         | Run 2                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Dense-page rows recovered     | 15/15, with both planned overlap references visible                           | 15/15, with both planned overlap references visible                                  |
| Whole-document exact rows     | 19/21                                                                         | 19/21                                                                                |
| Other errors                  | Page 5 extraction failed after returning usage; its two rows were unavailable | Page 5 returned two observations, but both failed exact amount/date/currency scoring |
| False rows                    | 0                                                                             | 2                                                                                    |
| Pages and tiles accounted for | 4/5 pages, 3/3 tiles                                                          | 5/5 pages, 3/3 tiles                                                                 |
| Total reported billed cost    | $0.00263552                                                                   | $0.00261458                                                                          |

The dense page improved from whole-page timeout/truncation to complete row recovery in these two runs. The repeated whole-document failure shows that this one-layout, text-only fixture still does not meet the release gate, even with tiling. Run 1's page 5 failure is classified generically by the privacy-safe adapter; returned usage does not identify the upstream cause. Run 2's page 5 error is a content-quality failure, so retrying blindly would be unsafe. Cost is low for the synthetic calls but does not establish reliability or cost for scanned bank statements.

Keep PDF upload disabled. The next evaluation needs varied text and scanned layouts, explicit page/region provenance, repeated trials, and manual row labels. The rendering strategy also needs proof in the actual deployment runtime; this harness uses local Poppler. No statement rows should be imported from OCR without user review and the existing atomic duplicate checks.
