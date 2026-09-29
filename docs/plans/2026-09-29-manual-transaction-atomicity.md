# Manual transaction quota follow-up

The web `POST /api/transactions` route now checks the current UTC month's
transaction count against `free_transactions_limit` before any financial write.
Only a `pro` subscription with `status = 'active'` bypasses that count. The CSV
confirmation RPC uses the same rule inside its existing database transaction.

The manual route still performs the quota read, transaction insert, balance
change, and counter increment as separate requests. Concurrent requests can
both pass the preflight, and a later failure can leave a transaction without a
matching balance or counter update. Replacement also currently consumes a new
counter slot even after soft-deleting the old row. The preflight is a release
guard against a canceled-plan bypass, not a guarantee of atomic accounting.

The next migration should provide an owner-scoped, `SECURITY DEFINER` manual
creation RPC. It should authenticate with `auth.uid()`, validate ownership and
payload, lock the monthly usage row, check the active plan, recheck duplicate
candidates, insert the transaction, apply any replacement and balance changes,
and increment the count in one database transaction. Add PGlite role, quota,
replay, concurrency, replacement, and rollback tests before switching the web
route. Review real account and transfer semantics before selecting the RPC
payload shape.
