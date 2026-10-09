# Email review, AI feedback, and native budgets — 2026-10-09

## Scope

- Web transaction editing sends only changed, allowed fields. A notes-only edit no longer resubmits an unchanged legacy event time. This failure class was reproduced with a regression test; the original failing owner's request payload was unavailable.
- Web budget movement lists flow with the page and cards do not stretch to match an expanded neighbor.
- Web and native inboxes filter receipt dates in Colombia time. Native uses the existing period selector.
- AI suggestion feedback uses shared multicolor styling, labels, and reduced-motion-aware native logo animation. Native email review opens before analysis completes, preserves owner edits, and distinguishes authentication, review-state, and consent failures. Editable controls remain mounted when an owner edit removes AI styling.
- Native budgets use WatermelonDB schema 10, cached owner snapshots, queued commands, idempotent server acknowledgment, and persistent local-to-server identifiers. Historical comparisons, category editing, monthly recurrence, and contributing-transaction links are available.
- Automation explanations are advisory. They use existing metered AI with consent, an owner/behavior/context/language cache, and an encrypted native offline cache. Rule saving and executable conditions remain independent.

## Delivery audit

The Gmail filter `{bancolombia from:notificaciones@lulobank.com}` was queried for October 6–9, 2026. All 36 returned RFC message identities were present in the owner's imported inbox: **36 matched, zero missing**. Current routing evidence contained 40 events with no GraphQL errors; the latest observed event was October 9 at 12:15:12 UTC. Raw messages, identifiers, credentials, and personal exports are intentionally excluded from this report.

The previous September/October recovery remains documented in `2026-10-08-mail-review-notifications-release.md`: 209 matching messages, 38 existing, and 171 recovered. Gmail filter execution history was unavailable, so an exact historical delivery failure cause has not been proved.

The owner's AI consents were granted. Today's telemetry contained 13 successful and one failed forwarded-email triage event. Telemetry deliberately stores no prompt or error text; it cannot establish the failed event's exact cause. A temporary authenticated account called the production web analysis endpoint using the native bearer/no-Origin contract and received HTTP 200. That account was deleted afterward. The specific iPhone email producing the unavailable-suggestions message still needs identification and a physical retry; a successful synthetic endpoint call does not prove that owner's case is fixed.

## Validation

- Backend: 100 suites, 796 tests exercised; 16 initial failures were SQL test timeouts under host contention. All 14 affected suites passed on bounded retry with a 30-second test timeout (100 tests). Final native-budget SQL tests: two passed. Backend TypeScript and lint passed.
- Web: 182 suites, 1,172 tests exercised; the initial local-PDF test timed out under contention. All five PDF tests passed in isolation afterward. Final TypeScript and lint passed; lint retains one existing React Hook Form compiler warning.
- Native: 99 suites, 275 tests passed in the final full run; final TypeScript and full lint passed. Regression coverage includes protected owner edits, date boundaries, mounted editable controls, legacy SQLite upgrades, queued budget retries, and acknowledged identifier remapping.
- Full formatter commands ran in all repositories; unrelated pre-existing formatting changes were excluded.
- Supabase migrations `20261009000034` and `20261009000035` applied successfully on October 9, 2026.

## Physical-device checks remaining

Review an email on the iPhone; edit a suggested field before analysis finishes and verify the edit survives. Open More → Budgets, create a limit offline, reconnect, and edit the still-open record. Change category/recurrence, inspect a historical month, open a contributing transaction, and navigate back. No device reinstall or local-data reset is required for these JavaScript changes.

## Published release and live verification

- Backend feature commit: `709959d`; diagnostic follow-up: `ae28043`. GitHub deployment runs `37958888798` and `37959899547` completed successfully.
- Web commit: `69d1147`. Vercel deployment `dpl_AWUXdk5eRhkoLyytFZvkPbMN6LVs` is Ready and aliased to `https://my.anotto.app`; the login page returned HTTP 200.
- Native commit: `58e0351`, pushed to main. Metro restarted with a cleared bundler cache on `http://192.168.68.56:8081`. The iOS bundle returned HTTP 200 and included the new review and budget modules; the temporary bundle was deleted. The installed development client was launched with the current server URL and accepted a subsequent reload command. Visual confirmation on the physical device remains a user check.
- An uncached production explanation initially returned HTTP 503. A seeded production cache read and a real-database/consent/cache-write isolation with intercepted model output both returned 200, isolating that failure to generation rather than account access or cache permissions. Diagnostics now expose only allowlisted stages/reasons; prompts and provider/DB payloads are never logged.
- The final real production test returned HTTP 200 with a 543-character explanation; its identical second request returned HTTP 200 with `cached:true`. The exact initial generation failure was not reproduced, so its cause remains unproved.
- The live native-budget RPC created a temporary owner's budget and replayed the same command with the same budget ID and `replayed:true`. All temporary users were deleted after testing; no owner transactions were posted or changed.
