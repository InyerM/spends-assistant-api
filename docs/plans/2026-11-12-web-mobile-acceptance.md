# Web and native acceptance scope — 12 November 2026

## Available in the local web candidate

Open `http://localhost:3000` on the Mac and sign in normally. This instance uses the production backend and database; it is not a disposable database sandbox.

1. **Accounts:** open an account with multiple currency ledgers and swipe/select the balance hero. Confirm that balances, recent movements and charts follow the selected currency without summing different currencies. Implementation: sibling web `app/(dashboard)/accounts/[id]/page.tsx` and `components/accounts/account-balance-hero.tsx`.
2. **Documents:** upload a synthetic receipt or an unencrypted PDF of up to five pages; choose **Extraer con Mistral OCR + DeepSeek**, review the separate external-processing consent, and extract. Confirm page evidence and editable observations. Extraction alone must not create financial transactions. Existing encrypted-PDF extraction remains a separate local-text path. Implementation: web `app/api/documents/[id]/extract/route.ts`, `messages/es.json`.
3. **Existing transaction analysis:** review description, notes and category proposals. Modify a proposed field, rerun analysis and confirm the human edit survives. If the original transaction changes, require a fresh analysis rather than apply a stale snapshot. Evidence: [release scope](2026-11-12-mistral-deepseek-review-release.md).
4. **Inbox rules/context:** use a fully evidenced synthetic capture and an explicit owned rule. A complete deterministic proposal should not consume an AI parse; incomplete evidence keeps the normal consent and model workflow. This is a bounded fast path, not universal deterministic classification. Evidence: [pipeline audit](../audits/2026-11-11-pipeline-audit.md).

Do not confirm financial posting merely to test extraction. The automated acceptance used disposable confirmed synthetic owners and deleted their exact storage and database fixtures.

## Explicit gaps

- Native Mistral OCR consent, extraction strategy and page evidence are not implemented yet. Native `src/lib/constants/ai-consent.ts` contains the previous three scopes; `src/lib/api/documents.ts` sends the optional PDF password but no OCR strategy.
- The accepted web account-detail carousel is not yet the native account-detail component; native `app/account/[id].tsx` still uses `CurrencySelector`.
- Independent deterministic history/contact mapping, catalog resolution and field-specific AI requests remain future pipeline increments; history currently informs the model. See the pipeline audit's remaining-work section.
- The security audit is not a blanket certification. Its broader unresolved findings remain tracked in [the cross-repository audit](../security/2026-10-22-cross-repository-audit.md).
- Web activation and Linux runtime acceptance succeeded on 12 November. The repository prerequisite for corresponding native implementation is satisfied; native work is still pending. See [publication status](2026-11-12-production-publication.md).

## Native testing sequence

From the sibling `spends-assistant-mobile` repository:

1. Run `pnpm typecheck` and focused Jest tests for the documents API, document actions and AI consent. The existing baseline passed typecheck and all 18 tests on 12 November, with no source changes. Logs: `/tmp/anotto-mobile-baseline-typecheck-20261112.log` and `/tmp/anotto-mobile-baseline-tests-20261112.log`.
2. After native adaptation, repeat the checks and run `pnpm ios` to build/install a development client in an iPhone simulator. This application uses native modules; Expo Go is not the test target. Use `pnpm start` for an already installed development client.
3. Test safe areas, keyboard, back navigation, currency gestures, busy states, consent denial/retry, source-page links and persistence after relaunch. Keep the app open beyond 20 seconds and navigate repeatedly to guard against the previous touch-lock regression. Existing XCTest guidance lives in native `tests/native/README.md`; it requires a booted simulator, installed application and authorized test owner.
4. Run `pnpm ios:device` for the physical iPhone. Validate the same flows plus camera/file intake, microphone permissions, background/foreground and network interruption. Signing or device trust may require the owner's interaction. A development-client run requires Metro; an independently launchable installation needs a release build.

Responsive browser checks at phone widths validate the web only. The iPhone's `localhost` is the iPhone, not this Mac; the current Mac server binds only to loopback. Use the published portal for Safari checks after release, or deliberately configure a LAN development server when needed. No device installation or native UI execution is claimed by the baseline unit checks.
