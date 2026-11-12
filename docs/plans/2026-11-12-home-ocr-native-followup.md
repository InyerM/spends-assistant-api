# Home currency, statement OCR and native follow-up

## Scope and visibility correction

The earlier carousel existed only in web account detail and exposed navigation only for multiple ledgers. The owner expected the ARQ-style currency interaction on Home. The new web candidate adds an always-visible current-account-balance carousel on Home and connects its selected currency to transaction queries, summary amounts, category/nature charts and recent transactions. Balances remain in their native currency; no exchange rate or cross-currency sum is introduced.

The server validates the currency filter and treats historical null currency as COP. COP-only budgets show an explanation when another currency is selected. Explicitly configured custom charts retain their own currency query. A balance trend is withheld when a current balance cannot safely establish the selected historical/incomplete/transfer ledger. Recent transactions filter their stored currency; destination-side FX transfer rows are not fabricated.

OCR controls are visible on pending document cards rather than hidden behind an initially closed disclosure. External-processing consent and explicit per-document acknowledgement remain mandatory. Already reviewed captures cannot be overwritten through this extraction action.

## Statement acceptance

A two-page synthetic scanned credit-card statement was processed through the production web/Worker/model/database path in one extraction action. It was classified as a statement and produced exactly these pending observations:

| Page | Date       | Currency | Amount | Description    |
| ---- | ---------- | -------- | -----: | -------------- |
| 1    | 2026-09-15 | COP      | -18495 | Management fee |
| 1    | 2026-09-01 | COP      | 625156 | Card payment   |
| 2    | 2026-09-01 | USD      |      5 | Card payment   |

The original source hash and page provenance matched. Transactions remained zero, accounts were unchanged, and both synthetic users and exact storage objects were removed without email. The two-page reservation settled at USD 0.004575. Evidence: `/tmp/anotto-statement-ocr-acceptance-20261112.json`; optional user test file: `/tmp/anotto-ocr-demo/extracto-demo-COP-USD.pdf`. This proves the tested statement, not universal bank-template accuracy.

Optional Mistral OCR accepts an unencrypted PDF of up to five pages / 5 MB, or a supported image. Encrypted PDFs retain the separate local-text/password workflow; passwords are not forwarded to the OCR provider. Extracted observations remain review drafts until explicit financial confirmation.

## Intelligence and security increments

- Complete captures can resolve classification from at least two recent, exact, unanimous, owner-scoped historical descriptions before model inference. Rules retain priority, including explicit category clearing. Conflicting, future, stale, saturated or unknown-category history abstains. This does not identify contacts by name or establish that historical categorization was manually verified.
- Paid parser, transaction/email/Telegram, automation generation/explanation and ambiguous triage paths use the existing atomic AI allowance. Consent precedes reservation and provider calls. Deterministic/cache paths do not consume quota; existing inbox/OCR reservations are not duplicated. This does not solve pre-deduplication triage races or per-alias ingress limits.
- Backend postal-mime is pinned to 4.0.8; web Next/Sharp are 16.4.1/0.35.5 with matching lint tooling. Narrow React lint compatibility changes preserve existing workflows. Production advisory counts and conditional reachability are recorded in the [security follow-up](../audits/2026-11-12-security-followup.md).
- CI pins official action commits, uses Node 22/pnpm 10.28.0, minimum repository permissions, bounded full tests and a production high/critical audit gate. YAML/actionlint and the local audit gate passed. Hosted CI was not executed because the previously observed account billing lock is unresolved.

## Validation and publication

- Backend `65d614e`: 154 test files / 1,176 tests; typecheck, lint and required formatting commands passed. Unrelated formatter-only changes were restored. Independent quota review passed 172 focused tests. Worker version `d2d7293e-87eb-4760-add5-5370274efdf6` is deployed.
- Web `f2c2be7`: clean production build, 295 test files / 1,579 tests, typecheck and lint passed (two existing nonblocking warnings). Authenticated browser fixtures verified Home at 320/390/1440 px, selected USD and no page overflow. Screenshots contain synthetic financial data and remain local in `/tmp/anotto-home-visual/`. The first deployment (`dpl_7rLi4Ar4LF48CV4hGTa3KL1ei1MH`) exposed an image packaging regression before OCR/provider dispatch. Follow-up commit `6e9951b` explicitly traces the Sharp root link; new regressions reproduce the missing resolution and execute the actual compiled PDF/PNG worker from an isolated trace archive. Its clean build, 31 focused tests, typecheck and lint passed. Deployment `dpl_2EHWHCV1XB1oKBr47Fz4s9idQm3T` is READY and its alias was independently verified as my.anotto.app. One actual PNG extraction on that release passed at 20:44 UTC: one pending observation, page/hash provenance, one reservation (USD 0.433527), settled charge USD 0.002244, zero financial mutations, and both synthetic users/storage removed. Evidence: `/tmp/anotto-sharp-link-production-ocr-acceptance-20261112.json`. Earlier failure evidence remains in `/tmp/anotto-new-runtime-ocr-acceptance-20261112.json`. Local port 3000 serves the corrected production build.
- Native source implements optional OCR, separate consent, source-page labels and Home/account-detail currency paging. Independent source reviews passed. Native full regression passed 242 suites / 776 tests before final focused carousel polish; the final focused nine tests and typecheck/lint also passed. A standalone Release simulator build succeeded and was installed only in the simulator: bundle `com.inyermarin.expensetracker`, version 1.1.0/build 2026101001, with a bundled JavaScript artifact independent of Metro. Evidence: `/tmp/anotto-native-release-simulator-artifact-20261112.json`. Synthetic runtime UI acceptance is in progress. No physical installation or distributed-client compatibility is claimed.

## Remaining boundaries

The entire improvement plan is not complete. Deterministic verified-contact resolution and field-specific AI requests remain separate increments. Security origin coverage, regex compatibility/resource limits, native OAuth/backup/signing and legacy financial grants remain tracked in [the next security gates](2026-11-12-security-next-gates.md). Revoking legacy grants requires evidence that released clients and offline queues have migrated. Native touch behavior, keyboard/safe areas, large text and real device intake still require runtime acceptance.

## Owner acceptance checklist

Open `http://localhost:3000` and refresh Home. The balance carousel appears above onboarding and period filters; with two real account currencies, change currency with its arrows or swipe. A single currency intentionally has no paging controls. This is a native-currency balance display, not a currency conversion.

For a safe OCR trial, upload `/tmp/anotto-ocr-demo/extracto-demo-COP-USD.pdf` as a new document in Documents. Choose the visible optional Mistral OCR action, read and acknowledge external processing, and extract once. Expected review observations are the three rows above, with their COP/USD and page provenance. Review observations do not post financial transactions. Existing reviewed documents cannot be overwritten; use a new upload for a repeat trial. The provider analysis uses DeepSeek with Mistral document parsing; encrypted PDFs use the separate password/local-text path.

Native acceptance uses a standalone Release simulator artifact with a synthetic owner, real test currency ledgers and an unextracted document, then checks navigation and currency changes after 21 seconds plus the explicit OCR acknowledgement. It does not substitute for a physical iPhone test or dispatch OCR without acknowledgement. Physical installation preserves the app identifier and existing data, after the web runtime gate and device availability are verified.
