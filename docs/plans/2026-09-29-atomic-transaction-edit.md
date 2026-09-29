# Atomic transaction edits

Migration `20260929000150_atomic_transaction_patch.sql` adds
`patch_reviewed_transaction(transaction_id, patch)` for the web transaction edit form. It runs as
one database transaction: it verifies the authenticated owner and allowed fields, locks the
affected accounts and transaction, updates the transaction in place, and reverses and reapplies
account balance effects only when amount, type, or accounts change. A failed balance update rolls
back the transaction edit. Repeating the same patch does not change balances again.

The RPC rejects edits to a transaction referenced by an accepted document observation or an
active Shortcut decision. A reversed Shortcut acknowledgement does not block an edit. The route
does not accept provenance or reconciliation fields such as `source`, `raw_text`, `user_id`,
`duplicate_status`, `is_reconciled`, or `deleted_at`. The review form sends explicit nulls when a
category or transfer destination is cleared. Financial edits of legacy transfers without a
destination are blocked because their original balance effect cannot be reversed reliably.

The RPC shares the owner advisory lock and account lock order used by manual transaction creation.
It also compares the row after acquiring its row lock to the initially read row, rejecting a
concurrent direct edit with a retryable conflict. This endpoint preserves transaction IDs and
monthly usage counts. It does not resolve existing balance discrepancies, and authenticated mobile
offline synchronization still has direct transaction write privileges until its separate migration.
