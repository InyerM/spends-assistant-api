# Reviewed incoming Shortcut transfer correction

## Context and approach

Six historical Bancolombia savings-account notices explicitly say the owner received a transfer, while their already matched transactions are stored as expenses. The owner identified one as repayment of a personal receivable, one as proceeds from a personal sale, and four as donations restricted to earthquake relief purchases. The correction must repair cash direction without treating all receipts as earned income.

Editing or rematching the immutable Shortcut decision would erase review provenance. Creating offsetting transactions would leave a false expense and duplicate the underlying bank event. Migration `20260929000230` instead provides one narrow, audited type correction and a separate reviewed flow role for reporting.

## Contract and financial effect

`correct_shortcut_matched_incoming_transfer` takes a stable request UUID, the transaction and active match decision IDs, expected account, amount, date and time, and one of these roles:

- `receivable_principal_repayment`: settlement of previously lent principal, not earned income.
- `personal_sale_proceeds`: a personal sale receipt; the sold item is unknown unless separately documented.
- `earmarked_relief_donation`: money received for restricted relief purchases, not personal income.

The function requires an active, uncategorized, single-account expense on an owner-owned Bancolombia savings account. It reads the immutable linked SMS and checks the explicit incoming-transfer phrase, amount, bank-account suffix, original date, and time against the current financial row. A reversed match, reviewed document decision, stale input, another owner's row, or any other state is rejected. It does not infer the role from the SMS; the role is supplied only after owner review.

The owner's saved Bancolombia account has debit-card suffix `7799`, while its transfer notices use bank-account suffix `2651`; the owner confirmed they represent the same savings account on September 30, 2026. The migration adds a separate `bank_account_last_four` field and an owner/institution uniqueness index. That field must be set on the reviewed account before any production correction. Once set, a transfer notice must match the bank-account suffix; the debit-card suffix alone cannot authorize a correction. Existing accounts without a separate bank-account suffix retain the prior `last_four` check.

One database transaction changes the type to `income` and adds twice the amount to the same account balance: it reverses the old expense effect and applies the incoming cash effect. The original Shortcut decision and snapshot remain unchanged. The append-only `shortcut_incoming_type_corrections` row records the reviewed role, original and new types, references, amount, and source-notice hash. The table permits at most one correction per owner and transaction, and a retry with the same request and inputs returns the same row. Owner-level advisory and row locks serialize concurrent edits, match reversals, and duplicate requests. A hard privacy erasure cascades to the audit row under the existing erasure guard.

A reversal insert is rejected while its matched transaction is active and referenced by a financial account correction, a payroll type correction, or this incoming type correction. This preserves the corrected row's evidence across all three existing audit paths. The guard leaves unrelated matches, foreign-owner attempts (which the foreign key rejects), and soft-deleted transactions to the existing reversal rules. Restoring a previously soft-deleted transaction after its match was reversed requires a separate review.

## Reporting and rollout

The role table is readable by its owner under RLS. Web reporting joins it to transactions on `(user_id, transaction_id)`: the unique constraint guarantees at most one role per transaction. Personal income excludes principal repayments, earmarked donations, and personal sale proceeds whose cost basis is unknown. All three remain visible as cash inflows with separate labels. Tax or gain treatment cannot be inferred from a sale receipt alone.

On September 30, 2026, the owner confirmed the card/account suffix relationship, the migration was applied, and the web role-aware report was published before financial corrections. Six originally reviewed notices and four additional owner-confirmed Kevin principal repayments were corrected through this RPC. The ten corrections total COP 3,486,000 of received cash and a COP 6,972,000 account-balance increase relative to their previously recorded expense direction. A real two-session test on the first reviewed correction committed once and rejected the competing request. The active transaction count remained 1,571. Kevin's cash settlement is not in the bank ledger, so his separate receivable journal remains uncreated.

The migration itself changes no production ledger data. Before each production call, recheck the active match, bank SMS, account suffix, expected financial state, and owner-reviewed role. Afterward verify a single audit row, unchanged transaction count and match snapshot, corrected type, and balance increase of twice the amount. Focused PGlite tests cover all three roles, replay, SMS mismatches, stale state, ownership, reversal guards for all three correction tables, competing requests, rollback, audit immutability, and erasure. An independent two-session PostgreSQL race check is a further deployment gate. A future audited undo is needed if an active corrected transaction must be reversed.
