# Interface, legal acceptance and chat follow-up

## Implemented scope

- Public support settings replace obsolete spendsapp.com seed destinations. The web also validates settings and falls back to support@anotto.app and the published landing FAQ.
- Account deletion actions wrap with 12px spacing and link to the published privacy retention section. No new retention deadline is promised.
- Inbox search matches the stored readable sender/subject/body fragment before pagination, remains owner scoped and escapes SQL LIKE wildcards. It cannot search attachment contents or content truncated at intake.
- Dashboard groups analytics and shows a monthly budget overview only when budgets exist; sidebar collapse control sits inside its header.
- New accounts must explicitly accept versioned terms; existing accounts retain access without fabricated consent. See ../security/legal-acceptance.md.
- Chat questions and validated answers are owner scoped, deletable and cascade on account deletion. History contains citation identifiers, not extra financial source snapshots, and is never fed back as model instructions. Scope classification occurs before financial reads; output/source validation and fixed read-only tools remain in place. These controls reduce injection risk without guaranteeing perfect detection.

## Statement email audit

A read-only production query on 2026-10-08 found three forwarded messages mentioning statements, two also mentioning Bancolombia. This identifies message text, not a successfully imported statement.

`src/utils/email-mime.ts` currently returns readable body/header fields and discards MIME attachments. `src/handlers/email-forwarding.ts` bounds raw MIME to 512 KiB. Existing Documents intake supports images; its bulk reconciliation reviews exact eligible matches before an explicit audited decision.

Therefore emailed statement PDF reconciliation is not yet available. Required implementation: bounded private attachment intake with provenance/deduplication, explicit encrypted-PDF password handling, extraction using an approved provider path, statement-period/account/currency validation, then preview of existing matches and missing items. Posting and balance correction must remain separate audited decisions. Never label a statement reconciled from the email body alone.

## Validation

- Backend full suite: 87 files, 720 tests passed on 2026-10-08.
- Web focused checks include help links, owner search/escaping, retention actions, terms modal, server guard query-string bypass, budget overview, sidebar, history deletion and source-link validation.
- Visual harness used actual components with synthetic data at 1440px and 390px: no horizontal overflow, correct public links, in-header collapse control and blocking terms dialog. This is not an authenticated owner-session browser test or a real Google signup test.
- The previously passing authentication tests needed a ResizeObserver test double and explicit checkbox acceptance after the signup change; their six cases pass.
- Published FAQ, privacy and terms URLs returned HTTP 200; the privacy retention anchor exists.
