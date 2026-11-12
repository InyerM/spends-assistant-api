# OCR and intelligence publication — 12 November 2026

Current status: web commit `8a7a8ae` is published at `https://my.anotto.app` as READY deployment `dpl_BQ49EEJzuNbe19pTUaVKNJxpBAWV`. The alias was independently verified at `2026-11-12T18:41:58Z`; public and local login returned HTTP 200. The earlier failure timeline below is historical. Final Linux OCR acceptance passed at `2026-11-12T18:42:12Z`.

The owner explicitly authorized backend, web and the two migrations with “dale autorizados”, and requested local port3000. No main branch was merged or branch protection bypassed. Source is preserved on `codex/mistral-ocr-audit-20261112` in both repositories.

## Verified preparation and database

- Backend candidate: `6b268a2`; web candidate: `8a7a8ae` (includes `fc03ae8`, Node 22 pin `132c525`, and compiled-worker fix `ec5cc10`).
- The release passed 1,154 backend tests, 1,563 web tests, subsequent focused checks and a production build. Independent review found no source blocker and required a fresh Linux build for Sharp, not upload of the macOS build.
- Verified custom-format private backup before SQL mutation: 2,328,225bytes,1,564 archive entries, SHA-256 `0f8827d814ebd01a9f11a85317f4f241c5f24028544aa067fd1260836fc88908`. Storage object bytes are outside this archive. Private manifest `/tmp/anotto-publish-20261112/backup-manifest.json`.
- Only `20261112000000_document_ocr_budget.sql` and `20261112000010_document_ocr_provenance.sql` were applied, in one transaction with migration-ledger entries, at `2026-11-12T17:54:58Z`. No historical captures were replayed and no financial posting occurred.
- Separate server-only proxy secret configured in Worker and web production environments; its value is not in Git or this report. Capability enabled, initial daily per-owner budget USD5. User OCR consent is still required.

## Backend publication

[GitHub Actions run43274488079](https://github.com/InyerM/spends-assistant-api/actions/runs/43274488079) never started its job: GitHub reported an account billing lock. This is not a code/test failure. The same reviewed candidate was deployed using the authenticated local Wrangler CLI instead, retaining existing queue/cron configuration and `EMAIL_AUTO_POST_READY=false`.

Cloudflare version `41de8323-394f-4233-84c5-9401246d4d62`; endpoint `https://expense-assistant.inyer-spends-assistant.workers.dev`. Health returned200 and anonymous POST `/documents/extract-pdf-ocr` returned401 after publication. Private deploy log: `/tmp/anotto-publish-20261112/worker-deploy.log`.

## Initial web publication failure timeline

Web source is uploaded from a clean `git archive`, excluding unrelated working-tree files and credentials. `packageManager` is pinned to tested pnpm10.28.0; install scripts remain governed by the existing policy. The Linux production build succeeded, but deployment `dpl_65BuAXvCbSAfBaK887TCxpvH8tKg` failed during publication with Vercel's reported internal error, not a compiler failure. Two further attempts failed at the same stage, including a Node 22 build. The fourth attempt using compiled-worker fix `ec5cc10` also failed after `Build Completed` at `Deploying outputs`; CLI deployment `dpl_EG9zx2yRaPTSgRwxXF5ZTDZ2rsqy`; its corresponding Git preview was `dpl_69N4XHYPzxQqnstYqRvXhAH5i3Zp`. Safe diagnostic evidence: `/tmp/anotto-publish-20261112/ocr-deploy-diagnostics-safe.json`. At that stage, the actual public alias still pointed to healthy previous deployment `dpl_C8uKAw2otsbty98VpHN9b4MM6GWX`; project target metadata must not be mistaken for the live alias.

An initial local archive-preparation command failed before extraction, and the CLI created an empty `web-source` project before it was interrupted. That empty project and its deployments were removed immediately through the CLI. No Anotto files or private data were uploaded to it. The existing Anotto project link was then explicitly verified before the real source upload. Private incident/cleanup logs are retained under `/tmp/anotto-publish-20261112/`.

## Local port

The owner explicitly approved stopping Renta Copilot on port 3000. Its local server was stopped; Anotto now listens on `127.0.0.1:3000`. `http://localhost:3000/login` returns 200. No fixture/preload authentication bypass is active. Existing port 3107 is retained.

## Runtime acceptance findings

- The original parent-side `createRequire().resolve()` calls became numeric Turbopack module IDs. Commit `ec5cc10` resolves dependencies inside the isolated worker instead. The compiled worker now processes both PDF and PNG; full suite: 287 files / 1,561 tests. Evidence: `/tmp/spends-ocr-compiled-worker-smoke.json`, `/tmp/spends-ocr-module-resolution-full-tests.log`.
- Production persistence was verified independently with a disposable synthetic owner and one observation: RPC 200, source page retained, no accounts or transactions changed, exact fixtures deleted. Evidence: `/tmp/anotto-production-rpc-isolation-result.json`.
- Local extraction initially returned 500 because ignored `.env.local` targeted an inactive `localhost:8787` Worker. The local URL now targets the published Worker. No budget reservation or provider inference occurred on those failed attempts.
- A subsequent acceptance-harness failure was caused by following a login redirect on the cookie-only web consent route while using Bearer authentication. The verifier now checks consent through the supported Worker API and asserts the returned decision; no application authentication bypass was added. Evidence: `/tmp/anotto-production-consent-isolation-result.json`.
- End-to-end acceptance passed at `2026-11-12T18:21:00Z`: compiled local web → production Worker → Mistral/DeepSeek → production database returned 200, one pending observation with source page 1, and no financial writes. One reservation charged USD 0.002277; exact synthetic users/storage were removed. Evidence: `/tmp/anotto-local-ocr-acceptance-green-result.json`. This verifies macOS compiled processing, not the pending Linux deployment. At that stage, Vercel activation remained blocked. No additional blind retries were made; the subsequent diagnosis and successful release are recorded below.

## Subsequent diagnosis

A deeper inspection of deployment metadata exposed `invalid_zip_file` at `patchBuild`: Vercel rejected files beneath symlinked directories in a function package. The built extraction trace reproduced ten directory-symlink/descendant conflicts; unrelated inspected traces did not. This is a concrete packaging defect, superseding the earlier absence of an actionable diagnostic. A focused regression test now checks the actual built trace. The correction removes broad manual OCR tracing globs and uses scoped imports to let Next.js trace the runtime dependencies normally. A clean build has 367 trace entries, 26 directory links, zero ancestor conflicts and no escaping link targets. A smoke test rebuilt an empty runtime from exactly those entries and processed both a PDF and PNG successfully. Independent review approved the source and artifact evidence. The corrected full suite passed 288 files / 1,563 tests in 136.09 seconds. Commit `8a7a8ae` reached READY as Git preview `dpl_BAULjt8wxwfkG2UHkTEzYKy4JUno`, confirming successful Linux packaging. Production deployment `dpl_BQ49EEJzuNbe19pTUaVKNJxpBAWV` reached READY and was aliased to `my.anotto.app`; no platform outage is claimed. Evidence: `/tmp/anotto-publish-20261112/ocr-package-isolated-smoke-result.json`, `/tmp/spends-ocr-package-clean-build.log`.

## Historical Vercel support draft — not sent

Project: `spends-assistant-web` (`prj_wzrq5dWlCBb424R8m3O1aAqcMvbF`). On 12 November 2026, four production deployments completed their Linux Next.js build, tracing and function creation, then failed while deploying outputs. The first three API results explicitly report an internal Vercel error with no actionable error code. The fourth CLI again reports an unexpected error after build completion. Node 22 and 24 attempts both exhibited the failure. The public alias remains on the previous healthy deployment.

Affected IDs: `dpl_65BuAXvCbSAfBaK887TCxpvH8tKg`, `dpl_BDe3GgcDuebD9WfhkdUFJaGBDPgu`, `dpl_3FjPUDGJKviLFTpFj9QZSbSydeqP`, `dpl_69N4XHYPzxQqnstYqRvXhAH5i3Zp`.

Please inspect the output activation failure and provide its internal cause. No source configuration cause is established from the available logs. Do not include credentials, raw private API responses, personal documents or database backups in a support submission.

## Final verification

Vercel activation and public alias verification succeeded. A single real synthetic PNG extraction through the deployed Linux Sharp/PDF worker, production backend, Mistral/DeepSeek and database returned HTTP 200. It saved one pending observation with source page 1 and cloud OCR provenance; transaction count stayed 0 and accounts were unchanged. Foreign-owner access returned 404 and anonymous access redirected to login (307). One reservation charged USD 0.002198; both exact synthetic users and their storage were removed without sending email. Evidence: `/tmp/anotto-linux-production-ocr-acceptance-green-20261112.json`, `/tmp/anotto-publish-20261112/production-alias-verified.json`. This is actual Linux runtime evidence, not an inference from local tests. Native adaptation remains a separate unfinished scope; see [the web/mobile acceptance guide](2026-11-12-web-mobile-acceptance.md).
