# Contacts and statement inspection — October 10, 2026

## Delivered design

- Keep the existing dashboard palette and shared controls.
- Constrain the contact dialog grid and flex children so long descriptions cannot widen the dialog. Stack the rename action on small screens.
- Summarize the complete contact catalog with five contacts ranked by transaction count, labeled horizontal bars, total contacts and reviewed movements. Do not aggregate amounts across currencies or derive statistics from a paginated directory page.
- Open the existing global transaction form from the transaction detail page.
- Read account identifiers and explicit statement periods locally from PDF text. Accept a unique active account match, including historical identifiers; leave ambiguous accounts unselected. Never infer the full statement cycle from its first and last transaction dates.
- Suggest monthly, quarterly or custom periods only when grounded in an explicit date range. Preserve existing scope and manual selections. The owner still confirms the comparison scope and each reconciliation link.
- Preview the original PDF with an owner-scoped signed URL that expires after five minutes. Passwords are used only by the local PDF parser and are absent from persisted data and AI requests.

## Verification

- Chromium checks at 375, 768 and 1440 pixel viewport widths showed dialog scroll widths equal to client widths, with long synthetic descriptions and categories.
- The initial web regression run passed 1,271 tests across 205 files; the additional PDF inspector interaction test verifies unlocking, key clearing and preview without financial posting.
- Focused inspection API tests verify owner scoping, short signed URL lifetime, foreign path rejection and unauthenticated rejection.
- The backend suite passed 903 tests across 113 files with two workers after the initial highly concurrent run hit SQL test timeouts. Typechecks and targeted lint passed in both repositories.
- Production verification confirmed migration `20261010000053` was applied and the contact detail function includes shared categories.
- Shared-category SQL regression verifies translated system categories without exposing another owner's category.

## Remaining statement issue

The real October 9 extraction returned zero movements. These inspection changes add account/period suggestions and the original PDF preview; they do not establish that the real statement's movements were extracted correctly. Verify that separately with the owner before describing reconciliation as complete. The mobile reconciliation draft remains preserved and unreleased.
