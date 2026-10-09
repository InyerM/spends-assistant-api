# Email duplicate review and attachment lifecycle — 2026-10-09

## Findings

The candidate endpoint used only an account's primary suffix and the old SMS amount/date extractor. Forwarded Bancolombia alerts contain COP-prefixed amounts and two-digit years; historical cards live in account identifiers rather than the primary suffix. Analysis did not open the independent candidate search. Candidate lookup now reuses the structured bank alert parser and all owned account identifiers, including historical ones. Missing or ambiguous evidence still produces no tuple suggestion, and explicit match confirmation remains required. Searches run again when opening analysis; they do not depend on paid AI success. The existing financial posting RPC still checks reviewed amount, date, and account before accepting creation.

The source link uses an owner-scoped individual inbox route, bypassing the default pending-status filter. Documents distinguish forwarded attachments from uploaded files, and counts include unprocessed files or pending observations while excluding archived evidence.

Bare Tailwind border utilities inherited the foreground color in nested inbox panels. Explicit semantic border tokens now keep evidence, candidates, and action separators consistent with the dark product palette.

## Statement delivery finding

The October 5 message from `extractosbancolombia@extractos.documentosbancolombia.com` was found both in Gmail and in the owner's application inbox, received on October 6 at 04:15:36 UTC. Its inbox status is `non_transaction`. The attachment filename identifies a September savings statement; the PDF is already stored, unarchived, with status `uploaded` and an immutable link to that inbox item. Its document creation timestamp is October 9 at 03:46:35 UTC.

PDF attachment intake was implemented on October 8 (`893b1ff`), after the original arrival. The later historical recovery preserved the attachment, but the older informational inbox classification remained. Therefore the statement is outside the pending-email tab and requires document extraction, rather than being absent from storage. No financial movement was posted by this audit. Cloudflare's saved event reports `dropped`/`worker`; that alone cannot prove application intake failure, and persisted inbox evidence establishes arrival. Gmail filter execution history and the original Worker exception are unavailable.

## Review semantics

- `non_transaction`: the email is informational rather than a transaction; linked documents remain available for independent review.
- `dismissed`: remove the email from pending review and archive its linked documents atomically using the existing audited archive function. No transaction or private file is deleted.
- Returning a dismissed email to `pending` restores only documents archived by that dismissal. Previously archived documents and later manual archive changes are preserved.

Migration `20261009000036_email_document_review.sql` implements the archive relationship and owner-scoped pending count. It was applied to production on October 9. Existing native queued email decisions also run through the database trigger.

## Validation

- Web: 188 suites, 1,186 tests passed; TypeScript passed. Lint has zero errors and one existing React Hook Form compiler warning.
- Backend: 101 suites, 800 tests passed; TypeScript and lint passed.
- SQL regression coverage includes owner enforcement, informational-email preservation, audited archive/restore, independent manual archives, pending counts, and transaction rollback if attachment archival fails.
- A temporary production account successfully exercised dismissal, restoration, and pending counts. No owner records were changed.
