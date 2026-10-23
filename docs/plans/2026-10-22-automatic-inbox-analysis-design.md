# Automatic inbox analysis

## Outcome

New inbox captures receive editable category, description and notes suggestions on the server,
using owner-scoped automation rules, relevant reviewed history and AI. The same persisted result is
available to web and mobile. Analysis never creates transactions, changes balances or confirms a
financial match. Existing explicit review and duplicate checks remain authoritative.

## Approach

A durable database outbox is preferred over client-side list effects: every ingestion path,
including direct native capture inserts, creates the same analysis job. Existing Cloudflare Queue
infrastructure processes these jobs; a minute-level scheduled dispatcher recovers arrivals from
clients that are offline or closed. Immediate authenticated intake can also request dispatch.
Running work during list rendering would repeat expensive work and miss closed clients; relying
only on an in-memory background promise could lose a capture when its process ends.

Each capture has one job with an owner, bounded attempts, an expiring lease and an explicit state.
Service-only SQL functions claim and finish work atomically. Owner read policies expose preparation
status, never permission to claim another owner's work. A discarded or confirmed capture invalidates
in-flight work. Duplicate deliveries do not repeat a completed analysis. No historical bulk replay
is initiated by this migration.

The analysis coordinator verifies forwarding eligibility for email and the corresponding current AI
consent for each source. It reserves existing AI usage before an external request and blocks cleanly
on exhausted quota. Rules apply deterministically to the evolving proposal; history and AI provide
semantic suggestions. Account selection requires unique owned evidence or an explicit owned rule.
Unknown account, category, date or purpose remains editable and is never invented for posting.

## Shared contracts

- Worker `POST /inbox/analyze`: authenticated owner, bounded inbox ID and optional refresh; cached
  ready result, a queued state, or a recoverable error. No raw message supplied by the caller.
- Worker `POST /inbox/analysis-dispatch`: authenticated owner-scoped IDs; queues existing durable
  jobs without waiting for external AI.
- Existing queue accepts a discriminated inbox-analysis job containing only an inbox ID. Existing
  authenticated email auto-post messages retain their separate disabled-by-default behavior.
- `forwarded_email_analyses` remains the compatible suggestion store, extended to version 3 with
  bounded JSON provenance. Public clients cannot complete jobs or assign a financial review state.

Web shows preparation status and uses the persisted suggestion as the initial draft. Refresh remains
available for a failed or stale proposal. Background completion must not overwrite edits already
made in an open form. Mobile retains suggestions locally and consumes the released web contract
after web deployment; its existing atomic inbox cache adoption must remain one database batch.

## Validation and release

Use failing tests for outbox isolation, lease/replay races, discard during analysis, quota/consent
gates, category and account ownership, rule chains and preservation of manual edits. No tests post
personal transactions. Review migration and worker/web contracts before release. The migration and
Worker precede the web release; corresponding new mobile integration follows that released contract.
Security audit and any production publication remain explicitly recorded as separate delivery work.
