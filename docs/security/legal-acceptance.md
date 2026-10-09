# Terms acceptance

The `20261008000022_legal_acceptance.sql` migration establishes version `2026-10-08`.
The published documents are https://anotto.app/terms/ and https://anotto.app/privacy/.

Existing accounts are grandfathered for access, without fabricating an acceptance record.
A protected `auth.users` insert trigger marks accounts created after deployment as requiring
acceptance, including Google accounts. Browser signup also requires an unchecked, explicit
checkbox; after authentication, the blocking modal obtains the durable verified-owner acceptance.
The application does not render protected children until the requirement is satisfied.

`accept_current_terms(text)` records the current authenticated owner, database timestamp, and
version. Repeated acceptance is idempotent. Clients cannot insert, alter, or delete the audit row.
The API checks same-origin requests and explicit current-version acceptance, then the browser
refreshes its session to obtain the protected app metadata. This is separate from optional AI
processing consent and age/country declarations.

Pending accounts are rejected by the web's shared API authentication helper and the Worker's
verified JWT helper. Existing RLS tables with a `user_id` column receive a restrictive policy;
a statement trigger also denies inserts and updates through SECURITY DEFINER functions. These
checks consult the database, so stale JWTs cannot grant access or keep accepted users blocked at
the database layer. New owner tables require the same policies/triggers in future migrations.

Account deletion remains available through its authenticated endpoint without acceptance.
Service jobs retain their separately authorized access. Owner audit rows cascade when the user
is deleted. No extra device, IP address, or user-agent fingerprint is stored.

Before deployment, apply the database migration first; then publish web and Worker changes.
Production verification should cover a fresh Google user, verified email signup, acceptance
retry, local sign-out, direct RPC denial before acceptance, and continued existing-account access.
