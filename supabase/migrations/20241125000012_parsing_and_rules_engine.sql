-- Skipped messages table for non-transactional message audit trail
CREATE TABLE skipped_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  raw_text TEXT NOT NULL,
  source VARCHAR(50),
  reason VARCHAR(100),
  parsed_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_skipped_messages_user ON skipped_messages (user_id, created_at DESC);
ALTER TABLE skipped_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_own_skipped" ON skipped_messages FOR ALL TO authenticated USING ((select auth.uid()) = user_id);
CREATE POLICY "service_role_skipped" ON skipped_messages FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Automation rules improvements: rule_type and condition_logic
ALTER TABLE automation_rules ADD COLUMN rule_type VARCHAR(30) DEFAULT 'general' CHECK (rule_type IN ('general', 'account_detection', 'transfer'));
ALTER TABLE automation_rules ADD COLUMN condition_logic VARCHAR(3) DEFAULT 'or' CHECK (condition_logic IN ('and', 'or'));
CREATE INDEX idx_automation_rules_type ON automation_rules (rule_type) WHERE deleted_at IS NULL;
