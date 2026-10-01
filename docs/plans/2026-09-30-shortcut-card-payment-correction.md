# Reviewed Shortcut card payment correction

## Problem and evidence

The August 3 Bancolombia SMS reports a COP 910,249 payment from savings account `*2651` to Amex credit card `*4899`. The existing matched transaction is an expense on the card account, so it understates the card balance and counts debt repayment as consumption. The August Amex statement contains posting `323723`, dated August 3, for a COP 910,249 payment on page 2 of `4899_AGO2026.pdf` (SHA-256 `6c921c57e931ed8bdc2df9184ceb4ee189b6674f62de11b4a60296656e87ca99`). The owner has confirmed that `*2651` is the Bancolombia savings account and `*4899` is the Amex Green card.

## Chosen correction

Migration `20260929000260` provides an owner-scoped RPC that converts the existing matched expense into one savings-to-card transfer while retaining its transaction ID and immutable Shortcut match. It requires the expected transaction state, an exact SMS amount/date/time and account-suffix match, active owned accounts, and a reviewed card-statement posting with a file hash, page, date, and amount. A request ID makes retries idempotent; a unique correction row prevents a second correction. Account deltas and the audit record commit together, and a corrected live match cannot be reversed without a separate audited undo.

Replacing the expense with a new transfer would orphan its existing Shortcut decision. A direct table update would lack the financial audit and replay check. The narrow RPC handles both historical layouts: an expense on the card restores the former card debit before adding the transfer legs; an expense already on savings retains that debit and adds the card credit.

The database validates the evidence fields and their stated date and amount; it cannot inspect the PDF bytes. The caller must verify the file hash and posting before invoking the RPC. Each additional historical card-payment expense needs its own matching statement. Extra August and September SMS amounts were not found in the available matching card PDFs, so those rows remain unchanged.

## Verification

Seven PGlite tests cover both balance layouts, idempotency, owner isolation, stale state, altered notices, incomplete or mismatched statement evidence, reversed matches, document-reviewed transactions, rollback, and append-only audit behavior. A rollback-only run of the migration and real August 3 correction against the linked PostgreSQL database succeeded, then confirmed the original expense and absent migration table remained unchanged.

## Published corrections

The migration was applied to the linked database on September 30 after a 953-entry logical backup (SHA-256 `b0cff929080fd9346b9149bcb03ef788509830b8757abe73ff3407b9705df647`). The August 3 Amex posting was corrected first and verified against its immutable match and both account deltas. A second 968-entry backup (SHA-256 `2244a5cbed9f2cf1a6243e8156eb1955b60911e379cc892133b6dc609d2aca4d`) preceded 11 further exact statement matches from January through March. In total, 12 existing expenses worth COP 24,943,071 became transfers without adding or deleting ledger rows; each has one audited correction and retains its matched Shortcut decision. The owner still has 1,659 active transactions. Private journals `amex-card-payment-correction-2026-09-30.json` and `statement-backed-card-payment-corrections-2026-09-30.json` record exact transaction and posting references.

The post-correction audit found 11 remaining active 2026 expense rows with explicit card-payment SMS text. Ten lack an exact posting in the available card statements. The eleventh, COP 421,924 on September 1 to card `*3971`, matches posting `045714` in `3971_SEP2026.pdf`, but no owned credit-card account currently carries that suffix. Its card identity must be established before changing its financial accounts. The 2025 manually described card payments also remain outside this SMS-backed correction scope.
