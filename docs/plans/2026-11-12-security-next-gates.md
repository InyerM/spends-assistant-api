# Security follow-up implementation gates — 12 November 2026

## Status and ownership

This is a follow-up plan, not implemented protection or a security completion claim. It extends [the current audit and local remediation record](../audits/2026-11-12-security-followup.md) and [the original cross-repository findings](../security/2026-10-22-cross-repository-audit.md). The Home/OCR release has passed production image acceptance (`6e9951b`); A09 was subsequently implemented and published as web `ea6749f`, with production acceptance in `/tmp/anotto-a09-production-acceptance-20261112.json`; its exact scope and residual limits are recorded in the sibling web `docs/audits/2026-11-12-mutation-origin-hardening.md`. A10 was subsequently implemented and published as backend `994e7d7` (Worker `63666ac2-e4b7-4907-9952-5eb03d495dea`) and web `ecce7ea` (deployment `dpl_em3MpWutR9T49V4tunncyHsYCwLT`). See [its bounded contract and acceptance](../audits/2026-11-12-bounded-automation-matching.md). Native runtime acceptance continues separately. This plan itself changes no application source, deployment configuration or database privileges.

Existing owner authorization covers continuing the security fixes. The gates below are evidence, compatibility and validation prerequisites; they do not introduce another permission request for already authorized work. The coordinator owns sequencing and independent review. A07 privilege changes must wait for compatibility evidence, rather than an arbitrary approval round trip.

## Priority and completion evidence

| Order | Work                                                                  | Implementation owner                               | Evidence required before declaring complete                                                                                                                                                   |
| ----- | --------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Finish and independently review the current A03/dependency candidate  | Current release coordinator                        | Full checks, frozen artifact/runtime acceptance and actual published version; the audit records local evidence only.                                                                          |
| 2     | A09 cookie mutation origin protection and compatible response headers | Web security implementer after the current release | Full unsafe-method coverage, valid native/Shortcut access, rejected foreign cookie mutations, production response headers and browser acceptance.                                             |
| 3     | A10 bounded automation matching                                       | Backend/web implementers with one shared contract  | Safe engine/grammar feasibility, rule compatibility inventory, matching parity and adversarial resource tests; corresponding mobile work follows the web contract.                            |
| 4     | A07 financial command authority and privilege cutover                 | Backend/database owner with native release owner   | Released-client inventory, complete command migration, deployed grants, role/concurrency tests and rehearsed rollback. Begin this inventory in parallel with A09; do not revoke grants first. |

A03 still has separate ingress/deduplication/input-bound work, documented in the audit. A05/A06/A08 native OAuth, signing and backup gates remain open there. This plan does not expand the current release to include those implementations.

## A09: inventory and exact-origin boundary

A read-only scan of the current web tree found **82 exported unsafe method handlers** (`POST`, `PUT`, `PATCH`, `DELETE`), of which 23 contain a local origin check and 59 do not. These are source inventory counts, not 59 demonstrated exploits. The private inventory is `/tmp/anotto-security-followup-20261112/a09-route-inventory.json`; it records method, path, source line and authentication shape. Imported/shared helpers were separately inspected. Temporary evidence is ephemeral; regenerate the inventory from the implementation snapshot before starting.

The unguarded groups include:

- Financial creation/review/import: transactions and their item/bulk/import variants, account corrections, accounts and balance changes, wealth links, investments/loans/receivables/relief funds, budgets and categories.
- Automation and intake: automation CRUD/generation/explanation, document upload/extract/inspect/decisions/restoration/reconciliation, forwarding-route changes and Shortcut inbox create/match/reverse/sender changes.
- Credentials/preferences: API keys, planning, notification updates, language/profile/user settings, session deletion and session tracking.

Concrete gaps include web `app/api/automation-rules/route.ts:42`, `app/api/documents/route.ts:48`, `app/api/transactions/route.ts:176` and `app/api/settings/sessions/track/route.ts:5`. The shared `getUserClient` accepts an optional Request (`web/lib/api/server.ts:16`); many unsafe handlers omit it, so that helper cannot inspect method/origin. Wealth operations discard request context in `web/lib/wealth/manage-record-route.ts:13`. These references are relative to the sibling `spends-assistant-web` repository and describe the inspected snapshot.

### Proposed implementation

1. Add a required-Request `getMutationClient(request)` beside `getUserClient`. Reuse the existing session/token verification, owner and legal/eligibility rules. Reject unsafe cookie-authenticated calls unless their source origin exactly matches the trusted target origin. Return a distinct origin error as HTTP 403, while retaining authentication failures as 401. Perform no mutation, provider request or signed-preview issuance after origin rejection.
2. Migrate every unsafe handler to the mutation helper, including shared wealth and email-forwarding wrappers and the cookie fallback in `getShortcutPostClient`. Keep requestless `getUserClient()` for actual read/server-component contexts. Consolidate the existing local guards only after equivalent tests pass. Do not add `middleware.ts`, and do not rely on `proxy.ts` as the sole enforcement point.
3. Exempt verified bearer credentials from cookie CSRF checks, preserving the existing exact path/method mobile delegation list in `web/lib/api/mobile-bearer-routes.ts` and `proxy.ts:32`. Header presence alone must never confer an exemption: malformed or invalid bearer credentials must fail authentication without falling back to a valid cookie. Keep the separate Shortcut per-user API-key verification and owner lookup before its exemption. Do not broaden the native route list as a side effect of passing Request into older cookie-only handlers.
4. Keep authenticated Worker dispatch unchanged: `web/lib/shortcut-inbox/analysis-dispatch.ts:23` sends explicit bearer credentials to the Worker, not cookie-authenticated calls to web mutations. Inventory other server-to-server consumers before rollout; a real cookie-based background consumer needs an explicit verified authentication contract, not a missing-Origin exception.
5. Make origin comparison consistent. Reject absent, `null` and malformed Origin on cookie mutations; compare scheme, host and effective port, not suffix or same-site membership. The current helper overwrites the request URL host from `Host` (`web/lib/api/request-origin.ts:6`); retain only justified development normalization and explicitly establish production proxy trust. Do not blindly trust arbitrary `Forwarded` or `X-Forwarded-Host` values. Derive the target independently of the incoming Origin. Test production custom domain, preview host and localhost behavior; a global list of accepted source origins is insufficient for exact-target comparison.

OAuth and recovery callbacks are existing GET handlers under `app/auth/callback` and `app/auth/recovery`; preserve their code exchange/cookies/redirects. Keep login and registration flows working. The scanned `app/api` tree does not establish the existence or absence of external platform webhooks; inventory any such integration separately and retain signature/secret authentication rather than applying cookie exemptions by pathname alone.

### Compatible response headers

Add shared headers through `next.config.ts` after the current frozen release. Start with `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`. The existing document preview and statement inspector embed PDFs (`web/components/documents/document-preview.tsx:38`, `statement-inspector.tsx:166`), so verify both signed storage previews and any blob-backed rendering before considering stricter framing.

A frame-ancestors-only policy does not establish a complete XSS defense. Do not add `default-src`, `script-src`, `connect-src`, `font-src`, restrictive sandbox directives, COEP/COOP or expanded HSTS in this bounded patch. Those need separate Next inline-script, font, image, audio, OAuth and external-integration evidence. Keep existing stronger per-document `no-referrer` behavior. Verify MIME types under nosniff, especially the JavaScript audio-worklet route.

Framework configuration reference: [Next response headers](https://nextjs.org/docs/app/api-reference/config/next-config-js/headers). Source/target-origin trust and sibling-origin concerns: [OWASP CSRF prevention guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

### Automatable acceptance

- Unit-test exact origin comparison across HTTPS/HTTP, default and nondefault ports, case/canonical URL handling, malformed/null/missing origin, sibling domains, misleading suffixes and untrusted forwarded/host headers. Include the actual localhost reverse-proxy case.
- Exercise cookie mutation routes with same-origin success and foreign/same-site-sibling/null/missing origin denial. Assert zero mutation RPC/table writes, provider calls and preview issuance on denial. Include document upload and privileged API-key/account/review operations.
- Test invalid bearer plus valid cookies, valid allowlisted native JWT without Origin, wrong-owner JWT, unallowlisted native paths/methods, and verified/invalid Shortcut API keys. Preserve owner-scoped review and the existing native route tests.
- Add a coverage gate that inventories all unsafe route exports and shared handlers, so a new route cannot silently use a requestless read-auth path. Pair this inventory with runtime denial tests; a text scan alone is not an authorization proof.
- Run the required web tests/typecheck/lint/production build, then browser smoke login, OAuth/recovery, document/PDF views, uploads, audio worklet and AI actions. Verify headers on pages, static assets, API errors and redirects in the built artifact and the deployed alias. Do not claim platform headers are absent solely because source configuration lacks them.

## A07: staged financial privilege cutover

Do not revoke authenticated transaction INSERT/financial UPDATE grants while a released offline native client still depends on them. The original audit identifies explicit legacy compatibility in `supabase/migrations/20260929000130_manual_transaction_atomic.sql:15`. The native tree now contains `src/database/transaction-command-sync.ts`, but source presence is not shipped-client evidence. Direct client grants and legacy service-role posting are separate bypass surfaces; closing one does not close the other.

Before the cutover:

1. Obtain a minimal released-version/build inventory for Android/iOS and their supported financial sync paths, including offline queued creates, edits, deletes, transfers and retries. Record which versions still issue direct table writes. Use non-sensitive version/operation metadata; do not retain receipts, descriptions, tokens or request bodies.
2. Verify actual deployed table/column grants, RLS, security-definer function grants/search paths, trigger protections and all authoritative command RPCs. Inspect metadata rather than assuming migration files exactly describe production. Inventory every backend legacy writer, including separate transaction/balance service requests and service-role bypasses.
3. Route supported financial mutations through owner-scoped atomic commands with idempotency, quota enforcement, currency/account ownership checks and balanced effects. Complete compatible native offline command replay and its release after the reviewed web contract. Preserve unresolved review/posting separation.
4. Define handling of old clients and pending offline queues. Prefer a compatible command rollout with an explicit supported-version boundary; unsupported clients must get a clear retry/update state without silently losing queued work. Establish the installed/shipped population and operational readiness before changing privileges. This is a rollout prerequisite, not a new request for authorization.
5. Rehearse migration and rollback against an isolated database, preserving all financial constraints. Take/verify the required private backup before any actual database mutation. Revoke only the identified direct INSERT/financial-column UPDATE privileges when compatible releases and command authority are verified. Do not blanket-revoke unrelated account/settings permissions or restore unsafe grants as a silent fallback.

Automatable gates: owner versus foreign-owner roles; denied direct writes after cutover; permitted read/nonfinancial metadata paths; one quota increment and balanced ledger effects under duplicate/concurrent commands; retries after uncertain network outcomes; transfer/currency/reversal invariants; offline queue restart and upgrade; least-privilege RPC execution; and final grants inspected after applying the complete migration chain. Use synthetic fixtures and actual multi-session PostgreSQL for race evidence. Mocked tests alone cannot establish production privileges or a concurrency guarantee. Record the deployed migration/version and rollback procedure before declaring A07 resolved.

## A10: bounded matcher and existing-rule compatibility

Historical planning snapshot: backend `src/services/supabase/automation-rules.service.ts:210` and web `lib/api/server.ts:139` executed owner-provided `description_regex` with JavaScript's synchronous backtracking engine. The published A10 replacement and remaining boundaries are linked above. Syntax exceptions already fail closed; they do not bound matching work. A Promise timeout cannot interrupt synchronous `.test()`. Keep this finding explicitly open until the execution boundary changes.

The preferred design is one shared matching contract with a non-backtracking engine or a deliberately restricted grammar evaluated with a bounded algorithm. Prefer the existing literal `description_contains`/`raw_text_contains` conditions for literal use cases. Do not attempt to prove safety with a few nested-quantifier rejection regexes. Bound input length, pattern length, rule count and total matching work as additional defenses, without claiming they alone make arbitrary backtracking expressions safe.

Compatibility prerequisites:

- Inventory existing expression features and lengths using sanitized aggregate metadata or an owner-authorized local review; avoid printing private rule patterns. Classify anchors, groups, alternation, quantifiers, Unicode behavior, lookaround and backreferences. Do not silently rewrite or delete existing rules.
- Run a feasibility spike for the chosen engine/grammar in the actual Cloudflare Worker and Next server runtimes. Verify WebAssembly/native/dynamic-compilation restrictions, package integrity, bundle/startup costs and memory limits before selecting a dependency. An engine supported by Node alone is insufficient.
- Specify and test case-insensitive matching, Unicode/accent behavior, empty versus absent conditions, invalid patterns, AND/OR keyword logic, account/category/destination restrictions and rule precedence identically across backend/web. Preserve the current English explanation of actual engine limits and propagate the reviewed web contract to mobile afterward.
- Reject unsupported new/edited expressions at validation. For existing unsupported expressions, expose a review-required compatibility state and prevent automatic application of an incomplete rule; route affected captures to review. Do not continue unsafe JavaScript execution as a hidden fallback, and do not silently treat an ignored condition as a successful rule match. Choose and document migration behavior from the compatibility inventory before rollout.

Automatable gates: a safe fixture corpus for supported syntax parity; unsupported/invalid expression rejection; fail-closed mixed-condition rules; long near-match and ambiguous-expression cases run only in a disposable, terminable test process; bounded memory/work at maximum input/rule counts; and actual Worker/Next runtime smoke. Verify no financial posting authority moves into the matcher. A proposed engine, short pattern cap or passing syntax test does not by itself resolve A10.

## Reporting boundary

Each item needs independently reviewed code, required local checks and separate deployed evidence where applicable. Keep open findings and residual limitations visible in the audit. Do not describe this document, an implemented-but-unreleased patch or a successful synthetic scenario as blanket backend/web/mobile security completion.
