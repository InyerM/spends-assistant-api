# Forwarded email analysis resilience

## Observed failure

Production returned HTTP 503 for an email analysis request on October 9, 2026. The corresponding
`triage_forwarded_email` usage event failed without token usage; adjacent requests using the same
configured model succeeded. The original handler did not log an error classification, so the exact
upstream failure behind that historical 503 cannot be established. The notice contained structured
purchase evidence; the web endpoint nevertheless returned before exposing those facts.

This is a provider failure and all-or-nothing review failure, rather than a merchant-specific
extraction rule. No private message contents or owner identifiers are stored in this report.

## Changes

- The shared JSON client retries network failures and HTTP 408/429/500/502/503/504, including error
  envelopes returned with HTTP 200. It makes at most three attempts within a 45-second deadline.
  Retry-After seconds are respected; a wait exceeding the deadline stops retrying.
- Each attempt remains metered. Authentication and authorization failures are not retried. Provider
  retention, training, and price restrictions remain present in every attempt.
- Errors carry only a safe status and classification. The forwarded email handler logs operation,
  model, failure class, and upstream status, never the message, token, or response body.
- Web analysis preserves deterministic bank evidence when enrichment is unavailable or invalid:
  merchant, amount, original event time, suffix, and the account resolved from current identifiers.
  Unknown fields remain empty. Current automation and validated history continue to take priority.
- Degraded evidence is returned with `ai_status: unavailable` and an amber review warning. It is not
  persisted as completed AI analysis, so the next analysis retries enrichment. Evidence descriptions
  are not highlighted as AI suggestions. A user's manual edits remain in place.
- Consent, authentication, authorization, and rate-limit responses keep blocking behavior. Source
  evidence does not authorize financial posting; explicit review and duplicate confirmation remain
  required.

Provider error-envelope behavior is documented in the
[OpenRouter error reference](https://openrouter.ai/docs/api_reference/errors-and-debugging).

## Verification

Regression tests first failed for provider 502/503/504 responses, network failures, HTTP-200 error
bodies, and the web evidence fallback. The passing tests cover bounded attempts and accounting,
nonretryable authentication, sanitized logging, consent enforcement, preserved evidence, and
successful enrichment on a subsequent retry. UI tests verify the unavailable warning, preserved
amount and manual description, and absence of the completed-analysis label.

October 9 local gates: backend AI, handler, and sender SQL suites passed 69 tests in 10 files;
backend typecheck and lint passed. Web full-suite passed 1,207 tests in 194 files; typecheck, lint (zero errors,
one existing React Hook Form warning), and formatting passed. Backend formatting passed for all
changed files; the repository-wide format command reports nine pre-existing files outside this
change.

## Limits

Provider outages can still prevent categorization. The fix preserves reviewable evidence and makes
failures diagnosable; it does not claim that AI will always succeed or that unknown categories can
be inferred without evidence. No existing financial transactions were created or modified for this
investigation.
