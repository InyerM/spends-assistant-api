# OpenRouter usage telemetry

The Worker records one internal event for each expense parse, automation generation, or document extraction attempt. This is visibility only: the US$10 per user per month figure is a planning estimate, not a budget or a customer limit. Telemetry never reserves money, rejects requests, or changes the existing request-count quota in `usage_tracking`.

## Flow

- `/parse`, `/transaction`, email and Telegram pass the resolved user ID and `AiUsageService` to `parseExpense`. Cache hits produce an event with zero upstream calls.
- `/automation/generate` wraps its OpenRouter call in `AiUsageService.track`.
- `/vision/extract` wraps its OpenRouter image call in `AiUsageService.track`. Only the attempt metadata is recorded; the image and extracted observations are not stored in telemetry.
- The OpenRouter clients meter each request attempt. HTTP errors, timeouts, and missing usage metadata have unknown cost. A retry with unknown cost makes the aggregate cost partial.
- `usage.cost` is stored as integer micro-USD when the upstream response reports it. Unknown costs remain `NULL`; the Worker does not guess model prices. `billed_calls` counts attempts that may have been billed, not reconciled invoice items.
- A telemetry write failure logs a generic message and leaves the request result unchanged.
- `ai_usage_monthly` is an internal monthly view. `AiUsageService.getMonthlyReport(month)` reads it. Months use the America/Bogota calendar.

## Privacy and retention

Events contain only user ID, month, stable operation, model ID, success status, attempt and token counts, and cost metadata. They contain no prompts, receipts, parsed results, account data, or error text. The migration grants table and view access only to `service_role`, blocks row updates, and cascades deletion with the user. The scheduled Worker removes events older than 12 months.

## Deployment

Apply `supabase/migrations/20260929000000_ai_usage_telemetry.sql` before deploying the Worker. There is no backfill. Internal cost reports are estimates and should be reconciled with OpenRouter billing before financial decisions.
