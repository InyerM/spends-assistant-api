# Web interaction corrections

## Accepted scope

- Keep the existing Anotto visual language. The owner explicitly requested functional navigation research into Binance and HubSpot.
- Put all dashboard widgets in a sectioned catalog; edit positions and dimensions on the live home canvas, with explicit save/cancel/reset. Keep this editor out of Settings.
- Start guided onboarding automatically for new users and resume across account, category and confirmed expense steps. Reset only the identified owner's onboarding preferences for testing.
- Exclude balance-summary cells from statement movements; preserve two distinct credit references and audited review state. Show incomplete evidence separately from confirmed differences.
- Add receipt upload in the transaction input modal and a recorded-audio fallback for failed browser speech recognition. Audio must remain transient, owner authenticated, consent gated, quota metered and routed through OpenRouter with zero data retention.
- Keep all design proposals in local-only files outside public routes. This preference is also recorded in the web AGENTS.md.

## Findings

The inspected Mastercard statement contained 19 draft observations: 16 undated summary cells, one dated fee and two dated credits with different reference IDs. The draft credits had outgoing signs because the prompt treated all payments as outgoing. The validator excluded a summary only when it had no amount and its complete excerpt matched a short list; numeric summaries bypassed that check.

The browser speech service reports network/service-not-allowed separately from microphone permissions. A granted microphone cannot repair that external recognition service. The fallback records at most 30 seconds and transcribes through OpenRouter using Gemini 2.5 Flash Lite, retaining the existing privacy routing controls.

## Navigation research

- Binance separates favorites from its full service catalog: https://www.binance.com/en/support/faq/detail/a24c83038cb442c1a0ecb528b44384a7
- HubSpot provides grouped tools and bookmarks: https://knowledge.hubspot.com/help-and-resources/a-guide-to-hubspots-navigation
- OpenRouter transcription routing does not support per-request privacy enforcement, so the implementation uses its audio-input chat endpoint with the existing zero-data-retention controls: https://openrouter.ai/blog/tutorials/transcription-on-openrouter/

## Deferred work

Native mobile parity, Apple Pay/Shortcuts, Back Tap, mobile push and Resend remain deferred until web acceptance.

## Delivery evidence — October 10, 2026

- Web release: `dpl_3UE63aGWoK5bBogoAcqKVAsdC8oq`, ready at https://my.anotto.app, with 12 catalog widgets and three editable sections.
- Worker release: `b9fa6ab5-b25d-4ae9-912c-c1dad81a0966`.
- Web validation: 221 test files, 1,294 tests; TypeScript, lint (one existing React Hook Form compiler warning) and production build passed. Backend validation: 119 files, 913 tests, TypeScript and source lint passed; statement regression tests passed after the final multilingual summary addition.
- Browser checks confirmed automatic entry, account-to-category-to-expense progression, dragging between sections, live dimensions, explicit save and cancel. Desktop 1440px and responsive 390px editor checks found no horizontal overflow.
- Existing statement repair used owner-scoped audited observation RPCs: 16 summary observations rejected as non-transactions, three real pending movements retained, two distinct credits corrected to positive incoming amounts. No transactions were posted or account balances changed.
- The identified owner's onboarding preferences were reset to `account` / `onboarding_dismissed=false` through `apply_planning_command`; transaction and account counts remained unchanged. Financial data was preserved.
- Live authenticated synthetic WAV transcription returned “Hello, I paid $20 for lunch today.” A second production browser check recorded a synthetic audio stream with the real MediaRecorder, sent the resulting WebM through the published app proxy and Worker, and filled the transaction text successfully. All seven production browser checks passed; synthetic owners were deleted afterward. Physical microphone behavior still requires the owner's browser check.
- The local navigation server binds only to 127.0.0.1:4317, serves no private data and adds no-index headers. Production navigation has not been replaced by an unselected proposal.

## Owner acceptance checklist

1. Reload the portal. Follow the automatic guide into account creation, categories and a confirmed expense; closing a form must not mark that step complete.
2. Open Edit home. Add/remove catalog widgets, drag across sections, resize, save and reload. Repeat a change and cancel; the saved layout must remain.
3. From New transaction, upload a receipt without automatic posting. Dictate a short amount/description; when browser speech fails, use Record voice then Stop and transcribe. Confirm the text before analysis or saving.
4. Open the repaired statement: summary cells must not appear as unmatched movements; the fee and two distinct incoming credits remain reviewable. Confirmed reconciliation must never create missing transactions or change balances.
5. Review navigation proposals at http://localhost:4317. The recommended direction keeps Home, Transactions and Assistant in the main sidebar, with searchable grouped modules and favorites in a separate catalog.

## Product terminology

Scheduled expenses are date-based records/reminders (for example rent on the fifth); they do not initiate bank payments. Frequent expenses are reusable templates (for example coffee) that the user confirms when used.
