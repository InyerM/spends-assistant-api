# Bounded automation matching — 12 November 2026

## Scope and release boundary

This candidate addresses A10 in [the follow-up plan](../plans/2026-11-12-security-next-gates.md). It replaces user-controlled JavaScript regular-expression execution in backend and web automation matchers with the pinned `re2js@2.10.0` engine. It does not revoke database grants, change native offline writes, migrate/delete stored rules, or close A07. Deployment remains a separate release gate.

## Engine and compatibility contract

[RE2](https://github.com/google/re2/blob/main/README.md) provides bounded, non-backtracking matching; [RE2JS](https://github.com/le0pard/re2js) implements that engine in JavaScript, avoiding native modules in Cloudflare Workers and Next.js. The package is MIT licensed and supports Node >=20; the tested application runtime is Node 22.23.4. Both lockfiles add only the exact dependency and its metadata; no unrelated resolution upgrade is intended.

The explicit contract is `re2js-unicode-v1`, case-insensitive matching. Lookaround, backreferences and inline flag extensions are unsupported. Unicode simple folding and code-point matching differ from legacy JavaScript `/i`: Kelvin sign/long s/capital sharp S fold with their corresponding letters; dot consumes an astral code point; ASCII `\\s` does not include NBSP. Accented text remains supported. Tests encode these differences; this is not a claim of full JavaScript regex compatibility.

Limits are 200 active rules, 512 pattern characters, 256 program instructions per pattern, 512 aggregate instructions and 8192 characters per description/raw-text input. Counted repetition/nesting receive conservative preflight checks. The compiled cache holds at most four patterns and resets DFA state after matching. Reads request at most 201 rows so an exceeded rule count is detected rather than silently applying the first 200. Limits fail closed with a typed review-required error; supported empty rule sets remain valid.

A read-only production aggregate on 12 November found 50 nondeleted rules, all active, and zero nonempty `description_regex` conditions. Only feature counts were persisted privately; no patterns, owner IDs or financial records were exported. This aggregate establishes the observed regex compatibility population, not proof of every distributed client or future rule.

## Unsupported rules and boundaries

Unsupported stored expressions cause the entire rule to be omitted from deterministic matching and AI prompt serialization. Other valid rules may apply. CRUD responses mark the unsupported rule as requiring review. Creating or activating unsupported expressions is rejected; an existing unsupported rule may be disabled without rewriting its expression. The current form preserves the existing expression and instructs owners to disable/recreate it with simple conditions. No destructive migration occurs.

All bounded-set and input guards run before action evaluation. Account detection during forwarded-email draft creation uses the same whole-rule check and evaluates the expression against the empty preparse description, preserving the backend contract. The candidate endpoint maps resource guards to HTTP 422. Rule infrastructure read errors instead produce a generic recoverable HTTP 500 before a financial command; private database details are not returned. Known resource failures map to HTTP 422 with `AUTOMATION_MATCHING_REVIEW_REQUIRED`; Telegram uses a friendly review message. Unsupported expressions are never delegated to AI as a fallback. Automated inbox analysis still produces review drafts; legacy direct posting authority remains tracked under A07.

## Verification evidence

Private synthetic evidence is under `/tmp/anotto-a10-20261112/`; it contains no production patterns or owner identifiers. RED tests first reproduced unsupported account assignment, excess-rule assignment and financial-command execution after a failed rule read. The corrected focused run passed 91 tests across four files; the candidate endpoint subsequently passed all 14 tests including typed 422. The backend integrated suite, including contact-pipeline commit `770b216`, passed 1208 tests across 157 files. Backend and web typechecks and lint passed. The final complete web run passed 1644 tests across 300 files. After the equivalent optional-capture access change required by lint, focused mirrored-helper tests passed (17 backend and 33 web tests), and both typechecks passed. Full web lint exited successfully with zero errors and two pre-existing warnings in import-dialog and transaction-form.

The actual helper was bundled (153465 bytes) and executed in a terminable Node process with 128 MiB heap and in real workerd without provider/database bindings. Each performed 136 adversarial calls with 8192-character input and an aggregate maximum of 510 allowed instructions: zero matches, approximately 35 ms in Node and 53 ms in workerd. Rule/work/input limit guards and unsupported expansion/lookaround checks passed. These measurements are bounded synthetic acceptance, not a latency guarantee or blanket security certification.

Independent review reproduced the original forwarded-account bypass and verified its corrected unsupported/no-match/201-rule behavior. The isolated Next 16.4.1 production build passed. All 28 owned web source files matched the frozen SHA-256 manifest in the build copy. Its exact extraction-route NFT trace was copied to an isolated archive (435 files and 31 relative links); PDF, PNG, JPEG and WebP each rendered one page successfully with original node_modules unavailable. No provider or database calls were made. The final full-web and lint gates passed as recorded above.
