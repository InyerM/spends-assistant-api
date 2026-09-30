# Shortcut payroll type correction

## Scope

Some historical Bancolombia savings-account payroll notices were matched to existing transactions classified as expenses. A normal transaction edit is blocked after a Shortcut match because the original review decision is immutable. This migration adds a narrow, owner-scoped correction for those linked transactions. It does not create, delete, rematch, or reclassify any other kind of transaction.

## Evidence and financial effect

`correct_shortcut_matched_payroll` requires the request UUID, transaction UUID, active match decision UUID, and the expected account, amount, and category. It reads the linked immutable Shortcut SMS and accepts only Bancolombia's explicit incoming payroll wording for a savings account. The SMS amount, event date, and event time must equal the transaction. The category must be the caller's active income category with slug `wage`; the current transaction must be a single-account expense. A reviewed document decision requires a separate correction.

One SQL transaction changes `type` from `expense` to `income` and adds twice the amount to the same account balance: reversing the old expense effect and applying the income effect. It appends a correction record containing the original and new types, owner, transaction, match, inbox item, amount, account, category, and a hash of the source notice. The original match decision and snapshot remain untouched. The request UUID is idempotent; a reused UUID with different inputs, a stale expected state, a reversed match, or another owner's record is rejected. Owner-level advisory locking, the inbox row lock, the account row lock, and the transaction row lock serialize competing financial operations.

## Rollout and verification

Apply the migration before invoking the RPC. Review each candidate's linked SMS and current transaction state, then call the RPC once per transaction with a stable request UUID. Verify the returned audit row, unchanged transaction count and match snapshot, corrected type, and an account balance increase of exactly twice the original amount. The migration itself makes no production data changes.

Focused PGlite tests cover the successful correction, replay, evidence mismatch, stale state, ownership, reversal, competing requests, rollback, row immutability, and privacy erasure. The parallel-request test uses one embedded connection; a two-session PostgreSQL race remains a deployment verification step.
