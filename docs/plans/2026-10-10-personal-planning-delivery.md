# Personal planning delivery — 2026-10-10

## Delivery status

Web implementation is available at https://my.anotto.app/planning and https://my.anotto.app/dashboard. iPhone implementation is compiled locally; installation and physical-device acceptance remain pending because the paired iPhone is unavailable. No App Store submission or paid Apple capability was enabled.

## Feature inventory

| Request                      | Implementation and evidence                                                                        | Practical scope                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Onboarding                   | Web `components/planning/onboarding-card.tsx`; mobile `src/components/planning/OnboardingCard.tsx` | Account setup, category review, first expense or receipt; progress uses existing records and dismissal persists. Confirmed expenses affect the ledger.                                                                                                                                                                                |
| Transfer dictation           | Web `hooks/use-dictation.ts`; mobile `src/hooks/useVoiceDraft.ts`                                  | Dictation fills an editable prompt in the existing analysis flow. Account, amount and destination require review. Mobile requires on-device recognition; unavailable languages/builds use the keyboard fallback. Web speech depends on browser support and its speech service.                                                        |
| Savings goals                | Migration `20261010000054_personal_planning.sql`; both planning screens                            | Target, manually tracked saved amount, COP/USD and optional deadline. Updating a goal does not move money or change account balances.                                                                                                                                                                                                 |
| Home alerts                  | Both `PlanningOverview` / `PlanningHome` components; migration 55                                  | Budget warnings, goal progress and upcoming expenses. Server goal notices at 80% and 100%; no automatic goal contributions.                                                                                                                                                                                                           |
| Custom dashboard             | Both `custom-charts` utilities and builders; `dashboard_widgets` preference                        | Hide/show/reorder blocks; up to three charts grouped by category/account, income/expenses and one currency. Web warns when its 500-record period sample is incomplete. Currency metadata includes inactive accounts.                                                                                                                  |
| Settings rows                | Mobile `app/settings/dashboard.tsx`, `notifications.tsx`, security row                             | Dashboard order, reminder switches/times and biometric lock use the settings navigation. Web dashboard controls use persistent preferences.                                                                                                                                                                                           |
| Recurring expenses           | Migration 55; worker `PlanningService` and 15-minute cron                                          | Monthly or every 1–366 days, selected account/category, local timezone. Automatic posting defaults off. Explicitly enabled occurrences pass through the existing ledger RPC with deterministic replay keys and quota checks; duplicates/errors pause posting for review. No bank payment is initiated.                                |
| Frequent expenses / Back Tap | Common expenses tab; signed shortcut `anotto-common.shortcut`                                      | Back Tap opens the saved-expense picker. Choosing an expense opens a prefilled review; final confirmation remains required. Device Back Tap setup is personal.                                                                                                                                                                        |
| Published shortcuts          | https://anotto.app/shortcuts/ and English/Portuguese counterparts                                  | Three signed access shortcuts: frequent expenses, dictation screen and inbox. Apple Pay/bank capture is a documented automation recipe, not a finished one-click capture automation. No key is embedded in downloads.                                                                                                                 |
| Capture locations            | Migration 56, `GET /api/purchase-locations`, both locations screens                                | Optional caller-provided coordinates/date. Only linked, confirmed expense captures appear. They describe capture location, not a verified merchant address. Opening Maps is explicit. Mobile keeps an owner-scoped SQLite cache.                                                                                                      |
| Biometric authentication     | Mobile `biometric-lock.ts`, `useBiometricLock.ts`, `BiometricGate.tsx`                             | Optional device lock, hardware/enrollment checks, authentication before enabling/disabling, lock on background/resume and sign-out escape. Uses Face ID/Touch ID or device credentials. This protects local UI; server session/authorization rules continue separately.                                                               |
| Scheduled notifications      | Mobile `notification-plan.ts`, `reminders.ts`, notifications settings                              | Optional daily reminder, daily summary and day-before scheduled expense reminders; device timezone, quiet hours and Disable all. Local schedule replenishes up to seven days when the app opens. A current-day expense suppresses that day's reminder after local refresh. This is not continuous background monitoring or APNs push. |

## Apple Pay and billing

Apple Pay is a payment method, and still needs payment processing infrastructure for merchant charges. For a future digital Anotto subscription sold inside this Colombia-first iOS app, keep StoreKit / In-App Purchase as the default rather than treating Apple Pay as a substitute. Billing remains inactive while Anotto is free.

Primary references: [App Store Review Guidelines, payments](https://developer.apple.com/app-store/review/guidelines/#payments), [In-App Purchase](https://developer.apple.com/in-app-purchase/), [Apple Pay](https://developer.apple.com/apple-pay/).

Apple's [Transaction trigger](https://support.apple.com/guide/shortcuts/apd65c67538a/ios) activates for selected card interactions; it does not provide general Wallet transaction history. The guide asks the user to preserve available event data, supply an individually revocable private API key, and confirm the resulting pending notice. [Back Tap setup](https://support.apple.com/en-us/111772) must be activated on the iPhone.

## Production evidence

- Initial web release: `dpl_JEHXje5XRM3sVuQpzH9vUAmHji7N`, Ready.
- Initial charts/location web release: `dpl_2fS12eHHZ3tdP4ndWkaFvaVX1WMv`, Ready on `my.anotto.app`.
- Final web release: `dpl_7tZBFVWc5ro9PdV3t8yiovutjq27`, Ready on `my.anotto.app`, source commit `617747e`.
- Initial shortcut guide release: `dpl_C2yXjt2zrsqz9xS8ZiXnLqPKSkQZ`, Ready on `anotto.app`.
- Final guide release: `dpl_6Ux1YhdDfSuiRZ2FTBWbWgmwxE2m`, Ready on `anotto.app`.
- Worker version: `a1562380-c1f3-4703-806d-06872631c11f`; existing monthly and 15-minute schedules preserved.
- Migrations 54–56 applied and registered. Production SQL verified the location RPC exists, anonymous execution is denied, and the posting processor is restricted to `service_role`.
- Disposable production owner verified creation/edit screens at widths 1440 and 390, common expense prefilling, saved chart display, inactive account currency metadata without changing the active account selector, mobile bearer access to planning/locations and no ledger entries from planning setup. The actual scheduled-source ledger RPC was tested twice with the same request: one created transaction and an identical replay. Temporary owner was deleted.
- Three signed shortcut downloads and all three guide locale routes returned HTTP 200. Guide mobile screenshot width was checked at 390 pixels.
- Build artifacts and private test credentials remain outside Git. No existing user's transactions were modified during these tests.

## Validation gates and source revisions

- Backend: **115 test files / 906 tests passed** with two workers; typecheck and lint passed. Source tests include planning owner isolation/replay/calendar, trusted recurring execution and capture location owner boundaries.
- Web: **213 test files / 1,280 tests passed** with four workers; typecheck and lint passed with one existing React Hook Form compiler warning. Two legacy UI tests initially timed out under simultaneous suite saturation and passed on bounded rerun; no test expectations were weakened.
- Mobile: **115 test suites / 318 tests passed**; typecheck and lint passed. This includes upgrades from schema versions 4, 8, 9, 10 and 11 to 12 with existing local records preserved, owner changes, biometric cancellation, voice draft isolation, quiet hours and Android picker dismissal.
- Landing: **3 test files / 22 tests passed**; build, typecheck and lint passed; distinct canonical/language paths and three signed artifacts were checked.
- Backend implementation source: commit `6847fdd` in `spends`.
- Native source: commit `5e86b0b` in `spends-assistant-mobile`; guide source: commit `f2d2b45` in `anotto-landing`.
- Native Release build and strict code signature verification passed; embedded bundle, version 1.1.0/build 2026101001 and microphone/speech permission keys were verified from the produced app.

## iPhone installation

The signed local build is **Anotto 1.1.0 (2026101001)**, with speech recognition and microphone permission descriptions, embedded JavaScript and no APNs/Apple sign-in entitlement. The physical phone was unavailable in `xcrun devicectl list devices`; installation is unproven.

The current local Personal Team provisioning profile expires **2026-10-11 16:20:42 UTC**. Rebuild/renew signing if testing after expiry; this is not an App Store distribution profile.

From the mobile repository:

```sh
xcrun devicectl list devices
./scripts/build-personal-ios.sh DEVICE_IDENTIFIER
```

Connect and unlock the iPhone and enable its existing Developer Mode. The script rebuilds a Release app with embedded JavaScript, requests provisioning updates using the configured Xcode account, verifies its signature and installs only when passed a device identifier. It does not submit to App Store.

## Acceptance checklist

Use a temporary account for expense posting tests.

1. **Onboarding:** Open Home with a fresh account; add an account, review categories and record an expense manually or with a receipt. Dismiss/reopen and verify progress persists. Any confirmed trial expense affects its account; remove it after testing.
2. **Goals:** Add a COP goal, saved amount and deadline; verify progress on Home. Change saved amount and confirm account balance is unchanged. Repeat separately in USD.
3. **Recurring:** Create monthly and every-X-days schedules with automation off; verify no transaction exists. Explicitly enable a small test occurrence. After its timezone/time and the next 15-minute worker cycle, expect one transaction, an advanced due date and a notice. A repeated cycle must not duplicate that occurrence. Conflicting existing transactions should pause automation and request review.
4. **Dashboard:** Hide/show and move blocks, reload and switch web/mobile. Add COP category and USD account charts; check currencies remain separate, then move/remove a custom chart. Narrow the period and compare the same underlying transactions.
5. **Offline:** Disable network on the iPhone, save/edit a goal and a frequent expense. Confirm pending state, reopen, restore network and verify web agreement without repeated records. Existing offline transactions must survive local schema upgrade.
6. **Dictation:** Tap Dictate, allow permission and say a transfer with amount/source/destination. Inspect the draft before confirming. Deny permissions or use an unsupported on-device language: keyboard entry must remain usable. No transaction is created merely by speaking.
7. **Biometrics:** Enable device lock in Security, background/resume, cancel authentication and verify financial screens remain covered. Authenticate to unlock and disable. Switch account and confirm lock settings do not leak across owners.
8. **Reminders:** Enable one reminder, set a near test time, background the app and check the notice. Test quiet hours, a local expense suppressing today's reminder, Disable all and sign-out cancellation. Reopen after a day/timezone change to refresh the local schedule.
9. **Back Tap:** Install the signed frequent-expense shortcut, assign it to Double Tap and select a saved expense. Confirm it opens a prefilled review and does not silently post.
10. **Capture:** Follow the Apple Pay or message-trigger guide with a private key. Inspect a pending notice before confirming. Test the exact same event twice and confirm intake replay; separately review duplicate financial matches.
11. **Locations:** Add optional coordinates to a synthetic notice, match/confirm it to an expense and open Purchase locations. Compare capture time/coordinates; explicit Maps navigation should work. Pending, reversed/unlinked and other-owner captures must not appear. Refresh, disconnect and inspect the cached mobile list.
12. **Compatibility:** Check Spanish/English/Portuguese, small phone layouts, text expansion, category search and date/time controls. Native permission prompts, signed shortcut import, Back Tap, real Wallet payloads and physical notification delivery remain device acceptance items.

## Remaining items

- Physical iPhone installation and the device-specific acceptance checks above.
- A one-click, installable Apple Pay/bank capture workflow beyond the published manual recipe; verify the actual iOS payload before promising extracted fields.
- Continuous background reminder suppression / push infrastructure is outside this local-reminder implementation.
- Statement reconciliation remains paused as previously requested; the earlier real PDF zero-movement extraction issue is not claimed fixed by this release.
