# Text model evaluation

A local harness for comparing text models on expense parsing before OpenRouter is turned on in production (issue #3). It sends the production system prompt (`src/constants/parse-expens-system-prompt.ts`) and uses the same privacy routing as `src/ai/openrouter.ts`. Production code is never modified or called.

## Commands

Run from the repository root. Node 22.6+ is required; no extra dependencies.

```sh
# Offline (default): fixture shape + privacy checks, then an oracle self-test of scoring and reporting.
node --experimental-strip-types --no-warnings --import ./scripts/eval/text-models/register.mjs \
  scripts/eval/text-models/run.ts

# Live (opt-in): requires --live AND a local key. Sends synthetic fixtures only.
OPENROUTER_API_KEY=sk-or-... node --experimental-strip-types --no-warnings \
  --import ./scripts/eval/text-models/register.mjs scripts/eval/text-models/run.ts --live
```

| Flag                 | Default                            | Meaning                                                                                                           |
| -------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--live`             | off                                | Call OpenRouter. Without it, no network request is made.                                                          |
| `--models a,b`       | DeepSeek V4.1 Flash + Qwen3 VL 30B | Comma-separated ids from `models.ts`.                                                                             |
| `--include-optional` | off                                | Also run GPT-5 Mini and Claude Haiku 4.5.                                                                         |
| `--repeats N`        | 1                                  | Repeat each fixture (1–10) to measure run-to-run variance.                                                        |
| `--max-usd X`        | 0.50                               | Abort before any call if the worst-case spend (4,000 input + 500 output tokens per call at list price) exceeds X. |
| `--no-write`         | off                                | Print only; skip writing `results/`.                                                                              |

Unit tests: `pnpm vitest run tests/eval`.

## What it measures

| Metric                  | Definition                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Field accuracy          | Correct scored fields ÷ scored fields. A fixture scores only the fields it lists; a missed transaction fails all of them.                   |
| Detection accuracy      | `is_transaction` matches the fixture.                                                                                                       |
| False transaction rate  | Non-transactions (OTP, promo, summary, reminder) returned as transactions.                                                                  |
| Missed transaction rate | Real transactions returned as non-transactions or failed calls.                                                                             |
| JSON validity           | Response parsed as a JSON object.                                                                                                           |
| Schema validity         | Passes the checks `parseExpense()` applies (positive amount, description, category).                                                        |
| Latency                 | Wall-clock per request, p50 and p95. No retries, so this includes provider queueing but no backoff.                                         |
| Cost                    | **Observed** from OpenRouter `usage.cost`, with the share of calls that reported it. **Estimated** from tokens × list price in `models.ts`. |

The verdict ranks models by `0.5 × field accuracy + 0.3 × detection + 0.2 × schema validity − 0.2 × false-transaction rate`. It declares a winner only when the lead beats a noise margin of `0.5 / √runs` (capped at 10 points) and the leader has at least 95% JSON validity. Otherwise it is marked **uncertain** and names the cheaper of the top two. With 17 fixtures the margin is 10 points, so use `--repeats` or add fixtures before trusting close results.

## Fixtures

`fixtures.ts` holds 17 synthetic cases: Bancolombia SMS and email (debit and credit), transfers, Nequi, manual messages, non-transactions, and relative dates (`ayer`, `el lunes`, `el 5`, and amounts that look like days). The clock is pinned to 2026-03-18 10:00 America/Bogota, so relative dates have one right answer. A field can list several acceptable values where the prompt allows more than one.

To add a case, write a new **invented** message and run the offline command. The privacy check rejects emails, URLs, phone numbers, and digit runs of 7 or more. It catches common mistakes, not every real message, so never paste a real SMS or email, even with parts removed.

## Privacy and safety

- Only synthetic fixtures are sent. Requests use `provider.zdr: true`, `data_collection: "deny"`, and a per-token price cap equal to the model's list price. Requests fail if no eligible endpoint exists, so a model without a ZDR endpoint shows up as HTTP errors, not as a silent policy downgrade.
- Reports contain fixture ids, field names, and aggregates. They never include message text, model output, or upstream error bodies. HTTP failures keep only the status code.
- The API key is read from the environment, never logged, and never written to disk. Do not put it in a committed file.
- Reports go to `scripts/eval/text-models/results/`, which is git-ignored. Do not commit live results. Paste the Markdown summary into the issue instead.
- Check each provider's retention policy on OpenRouter before running the optional GPT-5 Mini and Claude Haiku models.
