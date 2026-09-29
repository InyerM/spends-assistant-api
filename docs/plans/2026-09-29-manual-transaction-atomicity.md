# Atomic manual transaction confirmation

Migration `20260929000130_manual_transaction_atomic.sql` adds an owner-scoped
confirmation RPC. The web `POST /api/transactions` route sends its reviewed,
automation-processed payload to that RPC. It checks the current UTC month's
transaction count against `free_transactions_limit`; only a `pro` subscription
with `status = 'active'` bypasses that count. The CSV and Shortcut confirmation
RPCs follow the same plan rule.

The RPC serializes manual requests for one owner, locks involved accounts in
UUID order, rechecks duplicate candidates, locks the monthly usage row, and
applies a transaction, balance changes, and the usage count in one database
transaction. Replacement reverses the old balance effect, soft-deletes the old
transaction, then inserts the corrected one without consuming another count
slot. A caller-provided UUID idempotency key replays the same confirmed result;
the route generates one if none is provided. Direct authenticated writes to
`usage_tracking` are revoked to close counter-reset and preloading bypasses.
The RPC requires a category's type to match the transaction, a transfer to have
an active destination different from its source, and non-transfers to have no
destination. These checks prevent creating a financially incomplete transfer.

PGlite tests cover role ownership, quota, replay, duplicate review, transfers,
replacement, and rollback after a balance failure. They do not simulate
multi-connection contention against the hosted Supabase database. Before a
remote release, run that integration check and confirm no external browser
client still relies on direct usage-counter writes. Web callers
that need a reliable retry after losing a response should retain and resend
their own idempotency key; a fresh HTTP request without one receives a fresh
key. Mobile offline sync still performs authenticated direct `transactions`
upserts (`spends-assistant-mobile/src/database/sync.ts`), so this migration does
not revoke that grant. Such direct inserts can bypass the web RPC's count and
balance changes; migrating mobile sync is a release gate before treating the
quota as database-wide. Existing direct browser balance edits in other routes
remain a separate accounting-hardening task.

The current web form filters category choices by transaction type, but its
schema leaves transfer destination optional and does not clear a previous
category or destination when the type changes. Automation rules can also add a
destination to a non-transfer. Those payloads now fail in the RPC with a 400;
the current form shows a generic creation error. Add form-level validation and
clear stale fields when changing type, then constrain automation output before
the web release. Existing malformed historical rows remain untouched.
