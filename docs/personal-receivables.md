# Personal receivables ledger

Migration `20260929000210_personal_receivables.sql` records principal owed to the user by other people. It is separate from `manual_loans`, which tracks the user's debts to banks. The web review page is `/receivables`; it calls `/api/receivables` and the owner-scoped `confirm_receivable_event` RPC.

Each receivable starts as an empty borrower record with no inferred principal. A reviewed disbursement increases principal; a reviewed repayment reduces it. Both require a unique existing transaction owned by the user, matching the exact date, amount, currency, and direction. Each event stores the source transaction ID and an evidence reference. The RPC requires explicit review and a request UUID; an identical retry returns its prior result, while a changed payload for that UUID is rejected. A bank transaction cannot support more than one receivable event. Events must be entered in date order, and repayments cannot exceed principal owed.

This ledger never creates or edits transactions and never changes account balances or net worth. The transaction is already the cash movement. Once a disbursement is linked, the web dashboard excludes it from personal expenses while retaining it in cash flow; a linked principal repayment is excluded from personal income. A linked source cannot later change its financial amount, date, direction, account, owner, or deletion status through normal updates. Notes and other nonfinancial metadata can still change. An audited reversal/unlink workflow is needed before a linked financial source can be corrected. Hard deletion for privacy erases the entire affected receivable and its request receipts, avoiding a misleading partial balance.

## Reviewed historical examples, not seeded by this migration

- A COP 800,000 transfer to the user's brother on 2026-05-05 is a disbursement. His COP 100,000 transfer on 2026-05-19 is a principal repayment. The provisional outstanding principal is COP 700,000 if no other repayments exist. The incoming transaction must first be correctly classified as income before linking it.
- The COP 46,000 transfer from the same brother on 2026-07-15 was payment for an item sold, whose item is unknown. It must remain outside the receivable and must not reduce the loan.
- Kevin's personal loan is a separate receivable. His bicycle investment and gift remain separate from that loan. Cash repayments require their own recorded cash transaction before they can be linked here.

The module does not classify ambiguous incoming transfers automatically. The reviewer selects an existing transaction and confirms its purpose. No production records are created by this migration.
