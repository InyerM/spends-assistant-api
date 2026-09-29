# Web-first local release manifest

Status: **review draft; nothing published**. This records the current local backend `main` and web `main` release unit. It is not evidence that the resumed Supabase project has these migrations, secrets, or code. The mobile repository is outside this release.

## Release unit

| Area                    | Local contract                                                                                                                | Required pairing                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text AI and OCR         | OpenRouter text/vision adapters, user category catalog, token and actual returned USD telemetry, existing request-count quota | `OPENROUTER_API_KEY` in the Worker; migration `00000` for telemetry and `00100` for atomic request reservations before Worker deployment            |
| Private image documents | Image-only bucket/inbox, Worker draft extraction, owner-checked review and existing-transaction link                          | Migrations `00010`, `00060`, and `00070` plus the web extraction route must ship together; migration `00070` revokes the old browser completion RPC |
| CSV import              | One reviewed confirmation RPC for imports, duplicates, balances, and replay                                                   | Migration `00020` and web import API; UTC month now matches the other request/transaction counters                                                  |
| Historical Shortcut     | Idempotent raw-message inbox, candidate lookup, explicit existing match or new reviewed transaction                           | Migrations `00030`, `00080`, `00110` and the web `/transactions/shortcut-inbox` routes must ship together                                           |
| Wealth journals         | Tyba/Binance positions and Lulo/Bancolombia loans with exact amounts, ownership, and replay safety                            | Migrations `00040`, `00050` and web `/investments`, `/loans`; real openings and repayment splits need source statements                             |

Apply the new database migrations in filename order: `20260929000000`, `00010`, `00020`, `00030`, `00040`, `00050`, `00060`, `00070`, `00080`, `00100`, `00110`. There is deliberately no `00090` migration: PDF upload failed its synthetic quality gate and remains disabled. Do not create an empty placeholder.

## Evidence available now

- The complete integrated backend suite passed **328 tests in 35 files**; `tsc --noEmit`, ESLint, and `wrangler deploy --dry-run` passed on 2026-09-29. The Worker was bundled, not deployed.
- The complete integrated web suite passed **671 tests in 71 files**; `tsc --noEmit`, ESLint with zero errors, and `next build` passed on 2026-09-29. ESLint reported one pre-existing React Hook Form compiler warning in `components/transactions/transaction-form.tsx:162`.
- PGlite tests cover owner isolation, replay, direct-role denial, reviewed-document erasure, Shortcut duplicate rechecks, balance/quota updates, and request reservations. These are synthetic local database tests; they do not prove multi-connection PostgreSQL locking or the current remote grants.
- The read-only audit of the confirmed **1,516-transaction** profile and private 72-signal proposal file are documented in `docs/audits/2026-09-28-transaction-quality-audit.md`. No historical transaction was edited.
- The five-page invented PDF passed local rendering but failed model quality: Qwen 30B whole-page and Qwen 235B escalation missed the dense page; two tiled Qwen 30B runs recovered the dense page but scored only **19/21** exact rows end to end. See `docs/evaluations/2026-09-29-pdf-synthetic-tiles-live.md`.
- An eight-case invented BGE-M3 benchmark improved the held-out correct first suggestion from **1/4 to 3/4**, but the no-match case still received a false suggestion. No real document embeddings or pgvector schema were created. See `docs/evaluations/2026-09-29-document-vector-synthetic.md`.
- A read-only `supabase migration list --linked` check on 2026-09-29 showed the linked database ends at migration `20241125000019`; none of the local `20260929` migrations has been applied remotely. This check does not verify table grants, a backup, or application readiness.

## Approval and release sequence

1. Make a verified backup of the linked Supabase project. Confirm a staging path with real PostgreSQL sessions and test multi-connection quota/Shortcut races, RLS grants, hard-delete behavior, and image Storage policies. Do not use personal documents for these checks.
2. Obtain explicit production release approval. The release approval should name database migrations, the OpenRouter Worker secret, Worker deployment, and web deployment; a local commit or dry run is not a release approval.
3. Apply migrations in order. Deploy the Worker only after `00100` exists; deploy the web app only after document/Shortcut/wealth RPCs exist. Coordinate `00070` with the new web extraction route because an old web route cannot complete OCR after that migration. A short maintenance window may be needed.
4. Smoke test with a separate synthetic user: text quota, image draft and audited match/rejection, Shortcut replay/match/new distinct payment, CSV replay, investment/loan journals, and cross-owner denials. Verify no unintended transaction or balance write from OCR alone.
5. Compare returned provider costs to the planning estimate of USD 10 per person per month without enforcing a dollar cap. Ask for manually labeled real samples before claims about category quality, screenshot coverage, PDF statements, semantic search, or automated historical rewrites.

## Outside this release

No PDF upload, pgvector backfill, personal-data model evaluation, automatic Nequi categorization, audited correction of a mistaken Shortcut match, or mobile parity is included. These remain in `docs/plans/2026-09-29-web-issue-drafts.md`. The existing mobile working tree remains untouched.
