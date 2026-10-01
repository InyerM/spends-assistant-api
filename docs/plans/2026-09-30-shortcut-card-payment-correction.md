# Reviewed Shortcut card payment correction

## Problem and evidence

The August 3 Bancolombia SMS reports a COP 910,249 payment from savings account `*2651` to Amex credit card `*4899`. The existing matched transaction is an expense on the card account, so it understates the card balance and counts debt repayment as consumption. The August Amex statement contains posting `323723`, dated August 3, for a COP 910,249 payment on page 2 of `4899_AGO2026.pdf` (SHA-256 `6c921c57e931ed8bdc2df9184ceb4ee189b6674f62de11b4a60296656e87ca99`). The owner has confirmed that `*2651` is the Bancolombia savings account and `*4899` is the Amex Green card.

## Chosen correction

Migration `20260929000260` provides an owner-scoped RPC that converts the existing matched expense into one savings-to-card transfer while retaining its transaction ID and immutable Shortcut match. It requires the expected transaction state, an exact SMS amount/date/time and account-suffix match, active owned accounts, and a reviewed card-statement posting with a file hash, page, date, and amount. A request ID makes retries idempotent; a unique correction row prevents a second correction. Account deltas and the audit record commit together, and a corrected live match cannot be reversed without a separate audited undo.

Replacing the expense with a new transfer would orphan its existing Shortcut decision. A direct table update would lack the financial audit and replay check. The narrow RPC handles both historical layouts: an expense on the card restores the former card debit before adding the transfer legs; an expense already on savings retains that debit and adds the card credit.

The database validates the evidence fields and their stated date and amount; it cannot inspect the PDF bytes. The caller must verify the file hash and posting before invoking the RPC. The other historical card-payment expenses need their own matching statements. In particular, extra August and September SMS amounts were not found in the available matching card PDFs, so this correction is restricted to the confirmed posting above.

## Verification

Seven PGlite tests cover both balance layouts, idempotency, owner isolation, stale state, altered notices, incomplete or mismatched statement evidence, reversed matches, document-reviewed transactions, rollback, and append-only audit behavior. A rollback-only run of the migration and real August 3 correction against the linked PostgreSQL database succeeded, then confirmed the original expense and absent migration table remained unchanged.
