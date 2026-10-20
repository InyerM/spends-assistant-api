# Existing transaction AI review recovery

## Incident evidence

On October 19, 2026 (America/Bogota), production request logs showed two HTTP 503 responses from the existing transaction analysis endpoint at 04:21:38 and 04:21:55 UTC on October 20. Both referenced the same transaction. Read-only usage queries found two corresponding failed `parse_expense` events, each with one provider call and exactly 1,100 output tokens. Other reviews in the same interval succeeded.

The failed transaction had a 46-character description, no notes, and 156 characters of source text. The failure was not evidence of an oversized transaction input. No customer financial records were changed during the investigation.

The category review requested a maximum of 1,100 output tokens and did not enable the shared client's malformed-output recovery. A truncated response therefore failed immediately. Historical model responses and finish reasons were not retained, so the exact historical finish reason is unavailable; the token counts match the configured ceiling. The regression test reproduces the immediate failure using an explicit `length` finish reason, as well as incomplete JSON with a `stop` finish reason.

## Correction

- Start with a 2,048-token response allowance, matching the shared text client's default.
- Enable existing bounded recovery: up to three provider attempts within the shared 45-second deadline, doubling capacity after truncation, with an 8,192-token ceiling.
- Reject partial proposals throughout; preserve category ownership, evidence filtering, and explicit user approval before saving.
- Meter all provider attempts inside the same review operation. Recovery does not invoke the handler's quota increment again.
- Log only model, failure reason, parsing stage, and upstream status when recovery fails. Do not log prompts, transaction text, notes, provider response bodies, or credentials.

## Verification

- Before the change: four new regression assertions failed as expected; the two existing handler tests passed (`/tmp/anotto-review-failure-red.log`).
- After the change: 32 focused tests passed across category review, handler, recovery, and the shared OpenRouter client (`/tmp/anotto-review-recovery-green.log`).
- Typecheck and lint passed (`/tmp/anotto-review-recovery-types.log`, `/tmp/anotto-review-recovery-lint.log`).
- Production verification and release evidence will be appended after deployment.

## Limits

The provider can still fail after bounded recovery. No partial suggestion is returned or automatically saved in that case. This change does not claim that an external AI service will always be available.

## Production release

- Source commit: `294b02b`.
- Worker version: `f3022796-8c9b-4fae-aef2-7f5a127bc860`, deployed October 19, 2026 at approximately 23:31 America/Bogota.
- Full backend suite: 134 files, 944 tests passed (`/tmp/anotto-review-recovery-full.log`). Worker dry-run bundle passed.
- Real-provider production smoke: Spanish expense, existing own-account transfer, and Portuguese expense with long notes all returned HTTP 200 with valid bounded proposals. Category ownership and transfer semantics were checked. Disposable-owner cleanup succeeded (`/tmp/anotto-review-recovery-production-report.json`).
- Historical customer transactions were not re-saved or modified by verification.
