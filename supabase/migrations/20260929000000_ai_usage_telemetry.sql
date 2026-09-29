-- ====================================
-- AI USAGE TELEMETRY (NON-ENFORCING)
-- ====================================
-- Records model, token and estimated USD cost for OpenRouter text and vision operations
-- so internal cost reporting can compare real spend with planning targets.
-- This is visibility only: nothing here blocks or limits requests.
-- Request-count quotas in usage_tracking remain the only product limits.
--
-- Privacy: no prompt text, receipts, parsed output, error messages or account
-- data are stored. Only a user id, operation name, model id, token counts and costs.
-- Access is service-role only (no customer-facing state). Rows cascade-delete
-- with the user, and the Worker cron removes rows older than 12 months.
--
-- Costs are integer micro-USD (1 USD = 1,000,000 micros).

CREATE TABLE ai_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month TEXT NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  operation TEXT NOT NULL CHECK (operation ~ '^[a-z0-9_.:-]{1,64}$'),
  model TEXT NOT NULL CHECK (char_length(model) BETWEEN 1 AND 128),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  billed_calls INT NOT NULL CHECK (billed_calls >= 0),
  input_tokens INT CHECK (input_tokens >= 0),
  output_tokens INT CHECK (output_tokens >= 0),
  estimated_cost_micros BIGINT CHECK (estimated_cost_micros >= 0),
  cost_source TEXT NOT NULL CHECK (cost_source IN ('upstream', 'computed', 'partial', 'unknown', 'none')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_usage_events_month_user ON ai_usage_events (month, user_id);
CREATE INDEX idx_ai_usage_events_user ON ai_usage_events (user_id);

-- Events are append-only. Deletes stay possible for erasure and retention.
CREATE OR REPLACE FUNCTION public.ai_usage_events_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'ai_usage_events rows are immutable' USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER trg_ai_usage_events_immutable
  BEFORE UPDATE ON ai_usage_events
  FOR EACH ROW EXECUTE FUNCTION public.ai_usage_events_immutable();

ALTER TABLE ai_usage_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_ai_usage_events" ON ai_usage_events FOR ALL TO service_role
  USING (true) WITH CHECK (true);
REVOKE ALL ON ai_usage_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON ai_usage_events TO service_role;

-- Internal monthly cost report. security_invoker keeps the caller's RLS.
CREATE VIEW ai_usage_monthly WITH (security_invoker = true) AS
SELECT
  user_id,
  month,
  operation,
  model,
  COUNT(*) AS events,
  COUNT(*) FILTER (WHERE status = 'failed') AS failed_events,
  COALESCE(SUM(billed_calls), 0) AS billed_calls,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(estimated_cost_micros), 0) AS estimated_cost_micros,
  COUNT(*) FILTER (WHERE cost_source IN ('unknown', 'partial')) AS unknown_cost_events
FROM ai_usage_events
GROUP BY user_id, month, operation, model;

REVOKE ALL ON ai_usage_monthly FROM PUBLIC, anon, authenticated;
GRANT SELECT ON ai_usage_monthly TO service_role;
