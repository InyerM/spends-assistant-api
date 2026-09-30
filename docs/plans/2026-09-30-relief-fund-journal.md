# Reviewed relief fund journal

The user confirmed four incoming donations on August 14–16, 2026: COP 250,000,
100,000, 100,000, and 60,000. The COP 510,000 was earmarked for emergency
purchases after the August earthquake. It is not personal earnings. Some
supplies were bought with cash, but the user does not know the exact amount.
They recall a Dollarcity purchase of approximately COP 300,000. The dated
August 15 Dollarcity transaction for COP 90,500 is only a candidate and must
not be linked to that recollection without further evidence.

Migration `20260929000220_relief_fund_journal.sql` adds an append-only journal
independent of the bank ledger:

- `relief_funds` stores an owner-scoped purpose and COP currency.
- `relief_fund_entries` stores reviewed receipts, known outlays, and
  `unknown_spend` notes. Known amounts use exact decimal centavo strings.
  Unknown spending may have a null date and has a null amount; it contributes
  nothing to the calculated known remainder.
- Each entry records an immutable source kind and reference. An optional
  ledger transaction ID is validated for the same owner, direction, and exact
  amount, then stored with a source snapshot. Only one entry across all funds
  may reference the same transaction. The transaction itself is never written
  by the journal.
- `confirm_relief_fund_event` requires an authenticated owner, explicit
  review, and a request UUID. Repeating the same request returns the original
  result; reusing its UUID with different content fails. Browser clients can
  read their own entries but cannot insert, update, or delete them directly.

The web view at `/relief-funds` displays received money, known outlays, and
**known receipts minus known outlays**. If any unquantified spending is present,
it explicitly says the actual remainder is unknown. The review form requires
the user to inspect an entry before saving it.

This journal is a source-aware allocation record. It does not create or
reclassify transactions, adjust accounts, increase income, change spending
reports, or infer that the COP 90,500 Dollarcity charge was relief spending.
The four donation receipts should be entered only after the corresponding
ledger movements are correctly classified and reviewed. A cash outlay needs
an exact amount from evidence; otherwise record an `unknown_spend` note.

Focused verification is in `tests/relief-fund-sql.test.ts`, including owner
isolation, source amount matching, idempotency, unknown spending, and unchanged
bank balances.
