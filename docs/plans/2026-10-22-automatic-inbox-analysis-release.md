# Automatic inbox analysis release candidate

Date: October 22, 2026. Status: reviewed candidate; publication authorized by the owner on October 22 with “dale publica”. Deployment evidence will be recorded below once verified.

## Included behavior

- New pending inbox captures enqueue one durable suggestion job, including native/shortcut inserts while the app is closed.
- Existing Cloudflare queue and a one-minute recovery cron generate owner-scoped editable category, description and notes suggestions.
- Deterministic rules operate on the evolving proposal; relevant owned merchant history and AI establish the semantic proposal. Current explicit purpose takes precedence over usual merchant behavior.
- Source consent, email forwarding eligibility and atomic AI quota reservation precede external inference. Jobs expose pending/running/ready/blocked/failed states, bounded retries and expiring leases.
- Finishing a discarded capture cannot persist the stale proposal. Analysis does not register transactions, confirm matches or change balances.
- Web reads persisted results in two owner-batched enrichment queries, polls only preparation states, preserves manual edits and uses cached results before requesting another analysis.
- Generic parsing preserves source-supported optional notes and concise descriptions. Native local rules retain notes and respect chained account matching.

## Source and review evidence

- Design: `2026-10-22-automatic-inbox-analysis-design.md`.
- Schema and service-only authority: `../../supabase/migrations/20261022000010_inbox_analysis_jobs.sql`.
- Coordinator: `../../src/services/inbox-analysis.ts`; mapper: `../../src/utils/inbox-analysis-proposal.ts`.
- Authenticated handlers: `../../src/handlers/inbox-analysis.ts`; route/queue/cron wiring: `../../src/index.ts`.
- Independent audit: `../security/2026-10-22-cross-repository-audit.md`. Its baseline findings are not all remediated by this feature.
- Web candidate and checks: sibling `spends-assistant-web/docs/plans/2026-10-22-automatic-inbox-analysis-web-release.md`.

## Validation

- Full backend suite: 146 files / 1,060 tests passed, two workers and 30-second SQL timeouts. Private log: `/tmp/anotto-inbox-backend-all-tests.log`.
- That full run contained the original nine SQL outbox tests. Subsequent consent/forwarding resumption, stale-gate failure and ready-v2 repair changes passed all 15 focused SQL tests and independent review; private independent log: `/tmp/anotto-audit-20261022.aFahmR/final-sql-independent-tests.log`.
- Generic parse notes/prompt tests, proposal rule-chain tests, owner/consent/quota handler tests and queue routing are included in the full run.
- Backend typecheck, lint autofix and formatting commands passed; unrelated formatting-only edits were removed afterward. Final typecheck, repository lint and scoped source formatting passed: `/tmp/anotto-inbox-backend-final-types.log`, `/tmp/anotto-inbox-backend-final-lint.log`, `/tmp/anotto-inbox-backend-final-style.log`. Worker dry-run bundle succeeded without publishing: `/tmp/anotto-inbox-worker-dry-run.log`.
- Web full suite passed 279 files / 1,510 tests before the bounded final review fixes. The web release checklist distinguishes the subsequent focused and build checks from that full run.
- Final existing-contract mobile fixes passed 233 suites / 753 tests, including category/destination matching, evolving account/category/destination conditions and notes preservation. Private full log: `/tmp/anotto-inbox-mobile-final-all-tests.log`. Mobile typecheck and scoped lint passed. No new native shared-endpoint integration, build or installation is claimed here.
- All checks use synthetic fixtures. A separate PostgreSQL 17.11 instance passed four real two-session consent/verification versus stale-failure interleavings, plus cache repair, owner RLS, column/RPC permission and zero-financial-write checks. Private reproducible evidence: `/tmp/anotto-pg-race-ilyyhl0p/checks.log:26` and `run.py`; the Unix-socket-only server was stopped and its cluster/socket directories removed. This is bounded concurrency evidence, not an exhaustive interleaving proof. No live provider quality evaluation, deployed database/queue test or new physical iPhone verification has been performed for this candidate.

## Release sequence and approval boundary

1. Authorization received on October 22: “dale publica”, in response to the explicit migration → Worker → web → mobile release request. The prior October 21 bearer-proxy authorization is not reused.
2. Check the linked Supabase migration ledger and take the existing required private backup. Apply only the reviewed new migration; do not apply unrelated pending migrations implicitly.
3. Deploy the reviewed Worker containing the new service-only job pipeline and existing-queue discriminator; preserve `EMAIL_AUTO_POST_READY=false`. Verify health, cron/queue bindings and denial of anonymous requests. No new paid resource is required by the source design.
4. Deploy the reviewed web candidate. Its v3 enrichment requires the migration; its canonical analysis endpoint requires the Worker. Keep the rollback alias/version and do not remove the suggestion schema during an application rollback.
5. Verify an authenticated synthetic capture is analyzed once, reopens from cache, cannot be claimed by another owner and remains financially unposted. Verify blocked consent/quota and discard behavior without modifying personal ledger entries.
6. Only after the corresponding web contract is released and reviewed, implement the new native shared-result integration and prepare an in-place iPhone update. Preserve the working single-batch inbox adoption and installed freeze correction; never uninstall or reset user data.

## Security patch bundled with Worker candidate

The independently reviewed Telegram patch rejects unauthenticated, wrong-owner and unconfigured intake before parsing or constructing privileged services. Global webhook setup requires the configured owner and a canonical server URL. Deployment does not configure or register a bot automatically. If the required secret/chat/sender settings are absent, Telegram deliberately remains unavailable; the inbox feature does not require Telegram setup. See `../telegram-webhook-setup.md` for the explicit owner-only setup contract.

Remaining audit work includes supported dependency upgrades, legacy paid-AI reservation gaps, OAuth PKCE, Android release signing and staged review of direct financial grants. This candidate must not be described as a complete security remediation.
