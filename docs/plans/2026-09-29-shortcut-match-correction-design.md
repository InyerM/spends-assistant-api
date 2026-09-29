# Shortcut match correction

The inbox may acknowledge a real transaction incorrectly. A reviewer needs to undo that association without touching financial data, retain the original evidence, and make the message available for another explicit review.

## Design choice

Three approaches were considered. Mutating the original decision would lose the first review. Deleting it would also lose the audit trail. An append-only reversal linked to the original decision preserves both actions and lets a later decision be recorded. The implementation uses the third approach.

The database locks the owned inbox row for acknowledgement, creation, and reversal. One reversal exists per decision. A reversal returns `matched` to `pending`; retrying it returns the original reversal ID, even if the item has since been reviewed again. The old decision remains readable to its owner, but is excluded when finding the current decision. The same inbox item cannot be linked to the reversed transaction again: a stale retry cannot silently undo the correction, and deliberate reselection of that target requires a future versioned review flow. The raw message and receipt timestamp are immutable.

The web list resolves only un-reversed decisions for `matched` and `created` items. A reviewer must open a correction panel and confirm the reversal. The subsequent pending item can be matched to a different existing transaction or used to create a new transaction through the existing reviewed creation flow. A created decision cannot be reversed by this action because that would leave a financial row and balance change behind.

## Erasure and validation

Hard deletion of a transaction removes decisions and reversal rows for that transaction. The inbox returns to pending only if the deleted transaction was the current association. Deleting an older reversed transaction leaves a later match intact. Soft deletion retains the audit trail.

PGlite tests cover owner isolation, immutable audit records, idempotent retries, stale match rejection, later rematch and creation, direct status mutation denial, and hard deletion of an older reversed transaction. Web tests cover request validation, current-decision rendering, and a separate confirmation click. Multi-connection PostgreSQL contention and remote Supabase migration validation remain deployment gates.
