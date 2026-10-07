# Account identifiers and current review rules

## Decision

Each financial account stores up to 12 typed four-digit identifiers in `accounts.identifiers`. An identifier has a kind (`bank_account`, `debit_card`, `credit_card`, or `other`), an active flag, and a primary flag. Exactly one active identifier is primary when a list is nonempty. The database mirrors its suffix into `accounts.last_four` so existing account labels and integrations continue to work. The bank account suffix is also mirrored into the existing `bank_account_last_four` compatibility field.

For the owner's Bancolombia savings account, `2651` is the primary bank account ending, `9989` is an active debit card ending, and `7799` is a historical debit card ending. A historical identifier remains usable as evidence during review of old notices. Automatic posting requires an active matching card identifier and a verified sender.

## Rule refresh

Opening a pending forwarded email for analysis reloads current accounts and active automation rules. Account detection and deterministic category rules are reapplied to the cached suggestion without another AI provider request. An owner-confirmed `review_context` category is retained. A removed category rule clears a prior `automation` category suggestion. Existing posted transactions are never changed by this refresh; correcting historical postings is a separate audited action.

## Release order

1. Apply migrations `20261006000060`, `20261006000070`, and `20261006000080` after focused SQL tests. These are additive to the account schema and extend the owner-scoped pending analysis category source.
2. Release the web editor and review route. Set the owner's Bancolombia identifiers with an owner-scoped update after verifying the account ID and its existing suffixes.
3. Release the mobile schema version 8 and editor. Mobile sync sends the identifier array and projects the primary suffix to its local `last_four` field.
4. Test a current `9989` notice, an older `7799` notice, and a `2651` savings transfer. Verify that a rule edit changes a pending email suggestion without posting a transaction.

## Constraints

Four digits alone do not prove account ownership. Matching requires the owner, institution, account type, and transaction evidence. Ambiguous matches remain for manual review. Historical status is account metadata, not a rule for rewriting financial history.
