# Personal planning and iPhone capture

## Owner request and defaults

The owner authorized implementation without clarification on October 10, 2026. Ship web contracts before mobile counterparts, preserve existing financial review and provide an English implementation record with Spanish, English and Portuguese UI copy.

- Onboarding is a resumable checklist: create an account, organize categories, then review a first expense or receipt. Never post a synthetic expense automatically.
- Savings goals track an explicitly entered amount and target, currency and optional deadline. Updating progress does not move money between accounts.
- Scheduled expenses support a calendar month day or an interval of days. Automatic posting requires explicit opt-in when saving the schedule. Use the existing atomic ledger RPC and its duplicate and plan-limit checks; retries cannot post twice. Preserve the original month-day anchor across short months.
- Common expenses are owner-scoped templates. A shortcut opens their chooser; selecting one opens a reviewed transaction draft.
- Dashboard cards can be hidden and reordered with accessible controls; drag is an enhancement, not the only way to rearrange them. Existing budget alerts stay visible alongside goals and upcoming expenses.
- Notification rows configure reminders, daily summary and quiet hours. Request OS permission when a user enables notifications. Avoid a reminder if today's records already exist and avoid precise private financial details on a locked screen by default.
- Biometric unlock protects the signed-in local app. Verify biometric availability before enabling it, lock on background and provide a safe sign-out route if authentication fails.
- Dictation prepares a draft for review, including transfers; it does not bypass account/destination confirmation.
- Apple shortcuts use the existing capture inbox for bank messages and Apple Pay payloads. Location is optional, explicitly requested and labeled as capture location, not verified merchant location.

## Apple boundaries

Apple Pay is a payment method for goods/services, not a replacement for StoreKit digital subscription purchases in this Colombia-first product. No billing will be activated without actual configured products and release validation. Sources: https://developer.apple.com/app-store/review/guidelines/ and https://developer.apple.com/in-app-purchase/.

Personal transaction automations and Back Tap are configured by the iPhone owner; Anotto cannot activate them silently. Signed shareable shortcuts can simplify the action setup, but personal automation triggers still require user configuration. Sources: https://support.apple.com/en-euro/guide/shortcuts/apd65c67538a/ios and https://support.apple.com/en-us/111772.

## Gates

Use focused failing tests for SQL authority, recurrence dates, owner isolation, duplicate/replay behavior, biometric lifecycle and notification scheduling. Validate UI on small screens. Preserve owner data and do not commit the private Notes references. Treat physical iPhone verification, permissions, App Store purchase products and any untested external integration as explicit remaining work rather than claim them complete.
