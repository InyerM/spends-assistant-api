# Email review and notifications release

## Recovery and delivery audit

Audit date: October 8, 2026, America/Bogota. Scope: September 1 through the audit time,
using the owner's existing Gmail query `{bancolombia from:notificaciones@lulobank.com}`.

- 209 matching messages: 138 in September and 71 in October.
- 38 already existed in intake; 171 missing messages were restored using the existing MIME,
  fingerprint, owner-scoped intake and private attachment services.
- Final identity comparison: 209 of 209 present, with no missing identities.
- Recovery did not create financial transactions or change previous review decisions.
- Original RFC Message-ID fingerprints preserve idempotency. Historical timestamps are retained.
- Available Cloudflare logs contained 39 events: 38 captured messages and one Gmail forwarding
  confirmation. No missing message had a routing event in those logs. Three missing matches
  were sent messages, which Gmail's incoming forwarding filter does not forward.
- Most missing mail preceded forwarding activation. The connector does not expose Gmail filter
  settings or forwarding execution history, so the precise Gmail-side cause for every missing
  incoming message cannot be established from the available evidence.
- Private MIME, Gmail exports, routing logs and recovery comparison files remain outside Git.
  Counts were checked against live Gmail and Supabase; raw evidence is deliberately not published.

## Shipped behavior

All email financial posting requires manual review. Production `EMAIL_AUTO_POST_READY` is false;
queued and scheduled auto-post handlers use the same activation gate.

Notifications expose email arrival history, explicit individual/all read state, pagination and an
unread filter. Read state does not approve, discard or change an intake record. Email notices and
pending counts require a verified forwarding route. Budget notices use current-month 80% and
100% thresholds; the sidebar links to budget warnings.

Email transaction creation uses shared searchable category/account controls. Reviewed transfers
require distinct active owned COP accounts and post both legs through an audited owner-scoped SQL
function with replay protection.

Managed account rules synchronize active account aliases, preserve custom rules, protect managed
identities and do not consume the custom-rule quota. Ambiguous matches across different accounts
are left unresolved instead of selecting the first match. Native synchronization also refreshes
managed rules after successful account edits.

Categories expose searchable hierarchy and child results; automation separates creation from
filters and explains managed read-only rules. Approved Anotto tokens and typography are retained.

## Production database verification

Migrations `20261008000027`, `20261008000028` and `20261008000029` were applied through the Supabase
management API. Migration `20261008000030` additionally applies the existing terms gate to
notification RLS, writes and both definer RPCs. A temporary production account verified RPC denial
before acceptance and isolated access after acceptance; it was deleted. An owner-scoped transaction
verified the initial three versions, 12 managed account rules,
170 pending email records and one budget warning. Notification refresh returned 211 total notices
(including mail outside the Gmail audit interval and a budget notice). Verification was rolled back
so checking did not mark notices read or commit notification generation.

## Validation

- Backend aggregate suite: 94 files, 753 tests passed before final integration; final focused
  integration suite: 8 files, 135 tests passed. Final migration/forwarding suite after the terms gate:
  5 files, 75 tests passed. Backend typecheck and lint passed.
- SQL checks cover owner isolation, notification history beyond 100 entries, unread pagination,
  managed rule synchronization/immutability and reviewed transfer replay safety.
- Web aggregate release suite: 175 files, 1,134 tests passed. Production build, typecheck and lint
  passed (one existing React Hook Form compiler warning). Subsequent focused UI checks passed:
  six category/automation tests and seven mobile web navigation tests.
- Independent review found unread pagination could become empty after marking the last item read;
  two failing tests reproduced it and the fix resets the unread view after successful mutation.
- Local PDF parsing retains its 20-second worker deadline. Its integration test allowance is
  25 seconds so the worker can report its own bounded result under aggregate test load; assertions
  and production limits are unchanged.
- Impeccable static scans for changed categories, automation and notifications surfaces returned no
  findings. Desktop/mobile web screenshots use an isolated synthetic account. Independent visual
  review identified clipped mobile filter text, over-bright dividers and unnamed disabled delete
  controls; all three were corrected in one batch. Mobile web navigation now exposes Notifications
  in More. All three reviewer findings were resolved; final disposition: ship. The temporary QA
  accounts were deleted. The production authenticated smoke returned HTTP 200 for notifications,
  forwarding settings and the notifications page, with an isolated empty owner history.
- A local email-forwarding 500 was traced to an inactive localhost Worker, not a failed production
  service. The local Worker was restarted and its health endpoint returned HTTP 200.

## Publication and receiving domain

Web commit: `84f92df`; production deployment: `dpl_AKpBBRjy3BgU5KxyiBbYtfLaXR7H`, aliased to
https://my.anotto.app. The corresponding Vercel build completed successfully.

Worker domain release: `61e02824-d702-4267-8d13-611e1ee35022`; production health returned HTTP 200.
The forwarding primary domain is `receipts.anotto.app`; `receipts.inyerm.com` remains allowlisted.
Cloudflare enabled the receiving subdomain and three public MX records. The zone catch-all routes
to the existing Worker. The explicit support forwarding rule was compared before/after and is
unchanged. Existing user route addresses are retained; only newly created routes use Anotto.

Production synthetic route smoke: POST returned HTTP 201 with the Anotto receiving domain and
a 56-character local part; DELETE returned HTTP 204 and GET confirmed removal. The existing
owner route was compared before/after: its legacy-domain address hash, creation date and both
confirmation timestamps were unchanged. No email was sent; the temporary account was deleted.

Code release commits: backend `174f918`, web `84f92df`. Backend workflow:
https://github.com/InyerM/spends-assistant-api/actions/runs/37883110166.

## Remaining boundary

Native notification UI and native visual validation are separate from the web release. No claim of
an end-to-end SMTP test for the new domain is made without a received external test message.
