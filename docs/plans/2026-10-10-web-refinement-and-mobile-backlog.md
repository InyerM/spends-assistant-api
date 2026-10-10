# Web refinement and deferred mobile scope

## Scope and design decisions

The October 10 review prioritizes the web application. Preserve the approved Void Emerald and Amber identity. This is an application refinement, not a new Bencium identity exploration. The original ten-concept typography process is therefore not appropriate for these incumbent component corrections.

- Replace the large contacts summary with three compact panels: spending leaders by currency, the movement-count leader, and a small frequency ranking.
- Calculate contact spending across the complete owner ledger, separately for COP and USD. Exclude deleted movements and internal transfers. Keep the dashboard ranking explicitly labeled as all-history, independent of the dashboard period.
- Move dashboard controls and custom-chart creation behind a small **Edit home** action. Also make them available under Settings → Preferences. Reorder by dragging the handles in the editor or using the move buttons; changes persist to the owner account.
- Provide a movable attention widget with current-month budget thresholds and savings-goal progress.
- Show the original document directly from its intake card, before extraction, using an owner-scoped five-minute signed URL. Support PDFs and uploaded images.
- Recognize abbreviated Spanish billing periods sharing a year and account suffixes. A monthly cycle can cross calendar months; payment due dates are not statement-period endpoints.
- Treat explicit no-activity text as evidence of an empty statement only after looking for dated movements across the complete extracted text. A zero balance alone is not evidence of an empty statement. Unrecognized content remains unknown and requires review; never discard or post automatically.
- Use Driver.js for a guided tour of the real account, category and expense setup actions. Keep user confirmation for financial posting and allow the tour to be reopened from Settings → Help.
- Distinguish microphone permissions from browser speech-service errors. The compact dictation control never submits a financial movement.
- Add in-app notification preferences for email intake, budgets, goals and scheduled expenses. Suppress disabled new notices in SQL and apply the same preferences before pagination and unread counting. Pending review counters remain authoritative. Scheduled failures requiring review remain visible.

## Visual navigation proposals

The three interactive proposals are available in the web repository at `public/design/navigation-options.html` and, after release, at `https://my.anotto.app/design/navigation-options.html`.

1. **Fixed actions and collapsible spaces — recommended:** Home, Transactions and Assistant remain visible; Review, Organize and Wealth contain related modules; Settings contains help and integrations.
2. **Areas:** My money, Review and Tools provide fewer top-level decisions, with one extra click for common actions.
3. **Home and search:** Four fixed entries and a searchable module catalog favor experienced users but reduce module discoverability.

The proposals use illustrative placeholders, never private financial data. They do not replace production navigation without the user's selection.

## Scheduled versus frequent expenses

Scheduled expenses have a due date and recurrence. A reminder can prompt review, or an explicitly authorized automatic schedule can record its expense once on the due date. They help track predictable obligations such as rent and subscriptions.

Frequent expenses are reusable presets containing an account, amount and category. They open a draft for manual confirmation whenever invoked and do not assume the expense happens on any particular date. They are useful for repeated small purchases and the later iPhone shortcut / Back Tap workflow. Existing web presets remain available; their iPhone workflow is deferred.

## Verification record

- Web: 215 files / 1,287 tests passed with four workers before the final minor UI corrections; the affected focused suite passed afterward (13 files / 27 tests).
- Backend: 117 files / 908 tests passed with two workers. The additional owner-notification reader test passed afterward (five focused cases).
- Focused failing tests preceded billing-period parsing, speech error handling, widget reordering, intake preview access, contact aggregation and SQL notification suppression.
- The exact requested test identity was removed using the existing storage-cleanup and hard-auth-deletion workflow on October 10. Verified absent afterward; no other user identity was removed. Private execution evidence is in `/tmp/anotto-test-owner-deletion.json` and is not committed.
- New database migrations: `20261010000057_contact_insights.sql` and `20261010000058_in_app_notification_preferences.sql`.
- Browser speech-service availability cannot be guaranteed by microphone permission. Real microphone recognition in the user's browser requires a separate device check. The browser now reports service, language, microphone, permission and silence errors separately.
- The screenshots do not prove every page of the user's encrypted statement is empty. No password was stored or requested. The new inspection reads all PDF pages when the user unlocks the file and retains unknown states for review.

## Published release and browser verification

- Web source: `ea76c1b` (main feature commit `1882ae8`, preference-loading protection `7e28d5d`).
- Backend SQL source: `2bf04ba`.
- Production deployment: `dpl_8fmxMseFN4fmBG7YgktcbgKqnkFK`, READY on October 10, aliased to [my.anotto.app](https://my.anotto.app). Deployment URL: `https://spends-assistant-nlrhteagg-inyerms-projects.vercel.app`.
- Migrations 57 and 58 were applied transactionally and registered in migration history before web release.
- Final targeted production checks passed: complete-history contact spending/counts; explicit statement period/account/empty-text inspection; guided-tour action releasing the account form; drag ordering persisted to owner preferences; server filtering of disabled notices; all three interactive navigation proposals.
- An earlier browser batch verified pre-extraction PDF viewing at 1440 and 390 px and captured contacts/editor layouts without horizontal page overflow. The final follow-up changed only tour action handling and repeated its behavior check. A transient local network change interrupted one run; its disposable owner was cleaned up before retry.
- Disposable QA owners and synthetic uploaded files were removed. No production-user financial record was changed by these checks.
- Mechanical design detector returned an empty findings list. Typecheck, lint and production build passed; lint retains the existing React Hook Form compiler warning in `transaction-form.tsx`.
- Private local verification artifacts: `/tmp/anotto-refinement-core-report.json`, `/tmp/anotto-refinement-web-release-inspect.log`, `/tmp/anotto-refine-contacts-{1440,390}.png`, `/tmp/anotto-refine-editor-{1440,390}.png`. These artifacts are not committed.

Technical sources: [Driver.js configuration](https://driverjs.com/docs/configuration) and [browser speech recognition errors](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognitionErrorEvent/error).

## Acceptance plan

1. Open Contacts at desktop width. Check the three compact panels. Open the leaders and ranked contacts; the detail must match their confirmed history. Currency totals must remain separate.
2. In Home, open Edit home. Drag one visible widget above another; close and reload. Confirm the order persists. Repeat with the up/down buttons. Hide and show a widget. Check that budget and goal widgets indicate when they need data.
3. Create a custom chart in the editor or Settings → Preferences. Confirm every field has a visible label and chart creation is absent from the ordinary Home layout.
4. Open an uploaded PDF and an image from their intake cards before extraction. The original should open without creating transactions. For a protected PDF, enter its password only in the viewer or inspection prompt.
5. Inspect a statement showing `17 ago. - 15 sep. 2026`. Expect August 17–September 15 and a monthly cycle. Check every page before archiving an empty statement; zero debt alone must not trigger an empty result.
6. Open Settings → Help → guided setup. Navigate the three real controls by keyboard. Complete setup manually; nothing posts merely because a tour step advances.
7. Dictate a transaction. Confirm the text remains editable. If recognition fails, check the specific error; a network/service error must not incorrectly ask for microphone permission. No voice input should submit automatically.
8. Disable a notification group under Settings → Preferences. Confirm new notices in that group stop and the list/unread counter agree; pending email review and scheduled failure visibility must remain intact. Reenable and check the owner-scoped list.
9. Open each navigation proposal and compare the number of visible destinations. Choosing a proposal on the preview page must not change financial data or production navigation.

## Deferred backlog — web release remains the prerequisite

- Native parity for all reviewed web changes: budgets, contacts, document evidence, statement preview and reconciliation, guided onboarding, dashboard arrangement, notification preferences and AI field/review states.
- Native settings with sectioned rows, biometrics, dictation, local notifications and offline behavior: adapt and physically verify after the web acceptance round. Previously committed native code is not claimed as newly reviewed or installed.
- Apple Pay feasibility and product decision; installable Apple Shortcuts for banks, source capture and purchase locations; frequent-expense Back Tap workflow. Validate platform limitations before promising automatic detection.
- Mobile, email and push notification delivery after web in-app preferences are accepted.
- Resend migration and email templates after the current web work. Verify sender identity/domain before any configuration or send; preserve incoming receipts routing.
- Finish statement reconciliation with confirmed account/currency/date/amount links, visible missing ledger entries and unmatched statement rows, and reconciled transaction evidence. Never generate missing transactions automatically.
- Capture the actual browser speech error if the user's dictation still fails; evaluate a consented transcription fallback only if native browser recognition cannot serve the required browsers.
