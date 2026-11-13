# Inbox history review — 12 November 2026

## Reported surface and reproduced cause

The reported case belongs to **To review / shortcut inbox**, not statement or OCR analysis. The exact synthetic fixture is:

> Transferencia de $30,000.00 desde cuenta *2651 a la cuenta *3243466403

The parser extracts amount 30000, expense direction and source suffix 2651, but no merchant, event date or time. Previously, the inbox service required an extracted date before fetching exact destination contact history, and its deterministic proposal path required complete merchant/date/time evidence. The known destination history was therefore lost before the AI fallback. A focused RED test reproduced zero contact-history calls.

This fixture supplies two agreeing Barbería observations linked to the same owner's exact full destination. It does **not** establish what exists in the reported owner's production database: no production financial data or address book was inspected, and no provider call was made.

## Candidate behavior and financial boundary

A separate partial-history proposal uses exact owner-linked destination history without requiring complete posting facts. An extracted event date takes precedence. If absent, a finite server-stored `received_at` no later than server time bounds the history lookup only; it never populates `event_date` or `bank_event_at`. Invalid/future capture cutoffs abstain. The existing bounded history resolver requires agreeing observations, compatible owner/type/category and date window; conflicts and ambiguity abstain.

For the literal fixture, the result is `needs_review`, category Barbería, amount exactly 30000 from the message, and null merchant/event date/event timestamp. The source account is suggested only when the supplied owned account evidence identifies it. An outgoing unique full destination can use the owned contact's label in the neutral review description “Transferencia a …”; names and suffixes do not establish identity. Own-account suffixes and explicit own-account wording veto that partial external-recipient classification. Existing automation priority and explicit category clearing run after the historical candidate and remain authoritative.

Unknown facts stay empty; an explicitly validated event timestamp is preserved if a different fact, such as the account, is missing. Raw captured text remains unchanged. The proposal never posts a financial transaction. Consent, quota and model calls are skipped for a resolved deterministic partial proposal; unresolved captures retain the existing guarded AI path. The general parser's conservative no-amount extraction contract was not broadened for this amount-present case.

## Automatic and manual analysis; cache behavior

Automatic inbox analysis and the web manual analysis/refresh operation delegate to the same Worker service. The web route already preserves partial category proposals and nullable facts, so its candidate change is a regression test only. Existing stored analyses are not rewritten by deployment or by this change. An explicit refresh requests reanalysis; opening a cached analysis without refresh can continue showing the earlier proposal.

## Shared review fixes and independent review

The separate shared category-review service now resolves requested category/description/notes fields independently. A category-only request preserves original wording and notes; notes-only preserves category, wording and financial kind; a description-only request already resolved by exact contact evidence avoids AI/quota. Contact wording combined with AI category reports mixed provenance and field sources. Automation category resolution can coexist with deterministic contact wording; explicit category clearing stays authoritative. Backend and web schemas accept the resulting evidence/original provenance.

Independent read-only re-review found no remaining deterministic blocker in those final field merges. The inbox candidate was handed to the independent pipeline reviewer; integrated full-suite results are owned by that reviewer and are not inferred from focused results below. The web release remains the gate before corresponding native implementation. The optional native individual contact-name picker remains a specification only; no native dependency installation, permission request or contact access is claimed here.

## Verified local evidence

- `/tmp/anotto-inbox-partial-red.log`: exact literal service regression failed because contact history was never fetched.
- `/tmp/anotto-inbox-preserve-red.log`: a subsequent regression caught dropping an explicitly known event timestamp from a partial proposal.
- `/tmp/anotto-inbox-partial-green.log`: 33 tests passed across two backend files after both fixes.
- `/tmp/anotto-inbox-web-green.log`: 12 web canonical analysis tests passed, including explicit refresh returning the partial Barbería category without posting.
- `/tmp/anotto-inbox-typecheck.log`: backend `pnpm type-check` passed.
- `/tmp/anotto-inbox-lint.log`: focused backend ESLint passed.
- `/tmp/anotto-inbox-partial-manifest-20261112.json`: SHA-256 evidence for the five implementation/test paths; the report itself is separate.

No commit, deployment, production acceptance, financial mutation or blanket security certification is claimed by this report.
