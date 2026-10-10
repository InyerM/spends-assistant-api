# Forwarded email AI output recovery

## Evidence and scope

Production audit on October 9 found three log-confirmed truncated email suggestions at the 2048-token default and three invalid JSON responses. Previously, the shared completion client retried only transport and transient HTTP failures; output failures escaped that loop. Three additional failed usage events lacked correlated logs, so their causes remain unconfirmed.

## Decision

Enable malformed-output recovery explicitly for forwarded email suggestions. A shared global behavior change would affect unrelated AI features; switching providers without evidence would not address error handling. The existing provider privacy and price constraints remain in force.

All failures share a maximum of three upstream attempts and a 45-second deadline. Invalid envelope or content JSON triggers a fresh request. Truncation doubles the next attempt's output budget, capped at 8192 tokens; the first attempt remains at 2048. Failed output is never repaired, posted, or presented as a valid suggestion. Existing schema, ownership, confidence, and explicit timestamp evidence validation still applies to recovered output.

Meter every attempt exactly once, including discarded completions. Preserve known token/cost usage when JSON content is malformed or truncated; mark unreadable envelopes as unknown usage. Add safe `envelope` or `content` stage metadata to terminal errors without logging prompts, response bodies, or correspondence.

The email prompt requests compact JSON and bounds descriptions and notes to existing validation limits. No financial posting, inbox status mutation, or replay of real manually recorded emails is included.

## Verification

Focused failing tests cover both malformed JSON stages, recovery after truncation, bounded token growth and attempts, opt-in behavior, usage aggregation, and safe handler diagnostics. Run the complete backend test suite, typecheck, lint, and formatting before deployment. Web already allows 50 seconds for the Worker, so this backend release applies to both clients without a UI bundle change.

On October 9, verification passed: 839 tests in 103 files with `pnpm test:run --maxWorkers=2`, `pnpm type-check`, `pnpm lint:fix`, and Prettier for all changed files. The initial unrestricted test run was stopped after resource contention caused SQL test timeouts; the bounded full run completed in 164.85 seconds without failures. Repository-wide formatting was run, and unrelated formatting-only changes were restored to keep this fix focused.
