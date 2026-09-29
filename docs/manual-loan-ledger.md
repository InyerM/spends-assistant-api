# Manual loan ledger

Migration `20260929000050_manual_loans.sql` adds a separate, owner-scoped journal for Lulo Bank and Bancolombia loans. It does not read or write `accounts`, `transactions`, or any dashboard/net-worth totals. Apply the migration before releasing the web `/loans` page and `/api/loans` route.

A user first creates a lender record with a source reference. This records no principal, rate, term, or payment. A positive opening outstanding principal can then be recorded from evidence. Payments require exact cash paid and separately sourced principal, interest, insurance, and fee components; all four components must sum to cash paid. The RPC rejects payments before an opening balance, principal above outstanding, and entries dated before the latest saved event. It updates only the manual loan ledger in one transaction.

Rates and terms are intentionally absent from this first ledger. A loan record does not imply either is known, and no interest is calculated from a rate. The web entry form displays this explicitly. Future account/transaction reconciliation must identify matched principal transfers and expense components before any journal amount can enter spending or net-worth totals; otherwise it would double count existing transactions.

`confirm_loan_event` requires `auth.uid()`, explicit review, and a caller-generated UUID. Its result is durable by `(user_id, request_id)`; replaying the same JSON returns the first result and a changed payload is rejected. Authenticated clients have owner-only SELECT access and cannot mutate tables directly. The SQL assertions in `supabase/tests/20260929000050_manual_loans.sql` run locally against a mock Supabase baseline with PGlite.
