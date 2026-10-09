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

The intake now separates PDF attachments from readable message text. Verified forwarding accepts up to four signature-checked PDFs, each at most 5 MiB, within an 8 MiB MIME message. Unsupported attachments remain excluded. Private objects and immutable owner-scoped email provenance deduplicate repeated deliveries; a failed metadata insert removes its new upload. Messages containing PDFs never enter automatic purchase posting.

Documents supports original text PDFs, including encrypted statements. A bounded local PDF.js worker reads at most ten pages and 40,000 characters, with a 20-second timeout and memory limits. Passwords stay request-local and never reach AI. Image-only PDFs require screenshots. The financial-text consent and document AI allowance gate extraction; every bounded model call is metered, with one document allowance for the analysis. Drafts must cite source excerpts and grounded amounts; overflow or incomplete responses fail atomically.

The inbox links each attachment to its private Document. Existing audited reconciliation previews transaction matches and missing movements before explicit decisions. A saved PDF is not a reconciled statement; balances and posting remain separate reviewed actions. Previously received attachments were discarded by the old intake and are not retroactively recovered. A Gmail read-only search located the September savings statement on 2026-10-08; its attachment download failed with INVALID_ARGUMENT, so no recovery is claimed.

## Validation

- Backend full suite: 87 files, 720 tests passed on 2026-10-08.
- Web focused checks include help links, owner search/escaping, retention actions, terms modal, server guard query-string bypass, budget overview, sidebar, history deletion and source-link validation.
- Visual harness used actual components with synthetic data at 1440px and 390px: no horizontal overflow, correct public links, in-header collapse control and blocking terms dialog. This is not an authenticated owner-session browser test or a real Google signup test.
- The previously passing authentication tests needed a ResizeObserver test double and explicit checkbox acceptance after the signup change; their six cases pass.
- Published FAQ, privacy and terms URLs returned HTTP 200; the privacy retention anchor exists.

## Production release verification

- Database migrations 20261008000022 through 20261008000024 applied in one transaction (Management API HTTP 201).
- Backend commit `eda35cf`; GitHub Actions run 37874233104 succeeded. Worker deployment reported version `3033c565-b02e-4dd7-ad72-f4aa053bd766` before the successful CI redeployment.
- Web commits `cb4629d` and `0913140`; production alias https://my.anotto.app points to deployment `3DRZsNT9Mg9pcJUPSdLNRuTs2B7K`.
- Landing commit `0941b72` published the saved-chat retention disclosure at https://anotto.app/privacy/ (HTTP 200, content verified).
- Full web suite passed 164 files / 1086 tests. After the canonical session-metadata safeguard, the focused auth/guard/API suite passed 58 tests; web typecheck and scoped lint passed. Production builds passed.
- A temporary confirmed test account proved the protected new-account flag, denied preacceptance RLS reads, real deployed web acceptance endpoint with same-origin cookies, idempotent version audit, stale-JWT database acceptance, refreshed session metadata, and deletion cascade. The account and audit were removed afterward. Admin creation's initial response omitted trigger-added metadata while subsequent getUser returned it, so client initialization preserves verified metadata over stale INITIAL_SESSION and session-returning signup rechecks getUser.
- Live synthetic scope checks accepted a financial query and rejected an unrelated query. The upstream model returned non-JSON refusal content for an explicit override attempt; the production JSON parser fails closed before financial data retrieval. This limited check does not establish universal injection resistance.
- Mobile Metro responded `packager-status:running` at http://192.168.68.56:8081. Native terms implementation is handled separately after the web release.

## PDF and native follow-up validation

- Backend full suite passed 91 files / 741 tests; targeted MIME, storage, forwarding and provenance checks passed 51 tests. Database provenance tests cover foreign-owner rejection, immutable keys, duplicate delivery constraints and account-deletion cascade.
- Web inbox PDF links and statement-specific actions passed alongside existing inbox review tests (28 assertions); owner-bound terms acknowledgement passed three tests. PDF parsing tests include synthetic encrypted files and bounded overflow; a local encrypted Amex statement produced four pages and 7,417 characters without external processing.
- Mobile commit `445d6d2` adds the terms gate before sync, owner-specific acknowledgement, canonical session metadata and encrypted verified-owner offline cache. Fourteen focused tests, typecheck and scoped lint passed. Only new legal changes were committed; earlier unrelated local work remains untouched. Physical-device validation remains pending.
- Landing commit `439e0cf` updates the factual private-PDF disclosure; 20 tests, build and lint passed.

## PDF production release verification

- Migrations `20261008000025` and `20261008000026` applied atomically (Management API HTTP 201). Worker commit `893b1ff` deployed as `4f26a919-b59b-494c-9c30-100bef23e137`; follow-up security-subject redaction commit `d5c5bed` passed 39 handler tests and GitHub Actions run 37876443809.
- Web commit `3453b34` published to https://my.anotto.app; deployment `FnzAGb7NUMj2udK2V1ibWHchaxqn` is READY. Full web suite passed 166 files / 1100 tests, followed by 16 focused checks including password-to-consent/quota recovery, owner acknowledgement and encrypted PDF parsing. Production build and commit-hook ESLint/formatting passed.
- Landing commit `439e0cf` published to https://anotto.app; deployment `Bt9xSDiXwUGpKVPeBAje4JUsCRVy` is READY. Published privacy returned HTTP 200 with the PDF and ephemeral-password disclosure.
- A synthetic encrypted PDF passed the real MIME handler against production Supabase and private storage; repeating delivery produced exactly one inbox row and one document. This exercised the intake code and production services, not external SMTP delivery.
- The actual published web API returned the owner-scoped PDF link, requested a password (`PDF_PASSWORD_REQUIRED`), successfully opened the synthetic encrypted fixture, then enforced financial-text consent (`AI_CONSENT_REQUIRED`, HTTP 428). No model request or financial transaction was made. Temporary accounts, rows and private objects were removed.
- Mobile `445d6d2` is pushed and Metro remains available at http://192.168.68.56:8081. The first launch after this update needs an online canonical verification before the encrypted offline cache can be used. Physical iPhone and a real forwarded bank PDF remain user validation tasks.
- Only the primary worktree remains in each of the four repositories; no finished auxiliary worktree required removal.
