# Email review and notifications

## Approved product direction

The owner requested manual confirmation for every financial posting, including Lulo emails.
Historical recovery covers September and October 2026 using the existing Gmail query
`{bancolombia from:notificaciones@lulobank.com}`. Preserve original RFC Message-ID identities,
retain PDFs privately, and never convert historical recovery into financial posting.

## Delivery sequence

1. Audit Gmail messages against owner-scoped intake identities and available Cloudflare routing logs.
2. Disable the automatic email financial posting production flag, including queued and scheduled work.
3. Restore missing historical intake and PDF evidence without changing existing review decisions.
4. Ship canonical searchable category selection and reviewed transfers between owned accounts.
5. Ship persistent owner-scoped notifications with independent read state, email pending counts,
   and monthly budget notices at 80% and 100%. Reading never approves or rejects a transaction.
6. Synchronize account detection rules from active account identifiers without overwriting manual rules.
7. Refine categories and automation pages within the approved Anotto identity.
8. Verify and publish web before implementing corresponding native mobile surfaces.
9. Move new forwarding addresses to Anotto only after preceding milestones; preserve old addresses.

## UX direction

Reuse the approved near-black, emerald and amber system, existing typography, searchable selectors,
buttons, dialogs and navigation primitives. The notification bell opens an actionable list; unread
state remains explicit. The email navigation destination displays pending work. A budget warning
links directly to budgets. Category search reveals matching child categories. Automation separates
rule creation from search and filters, including useful error and empty states.

A global replacement visual direction or ten unrelated typography concepts would conflict with the
owner's already approved product identity; this work applies that committed system.

## Validation

Focused failing tests precede behavior changes. Validate owner isolation, idempotent intake,
independent notification reads, financial transfer balance updates and replay safety. Run relevant
SQL tests, aggregate tests, type checks, lint, production build and bounded visual inspection.
Private Gmail exports, original MIME, receipts and logs remain outside version control.
