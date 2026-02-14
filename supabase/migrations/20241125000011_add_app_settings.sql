-- App settings (dynamic key-value configuration)
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Readable by authenticated users, writable only by service role
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_read_settings" ON app_settings FOR SELECT TO authenticated
  USING (true);
CREATE POLICY "service_role_all_settings" ON app_settings FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Seed default limits
INSERT INTO app_settings (key, value, description) VALUES
  ('free_ai_parses_limit', '15', 'Monthly AI parse limit for free plan'),
  ('free_transactions_limit', '50', 'Monthly transaction limit for free plan'),
  ('free_accounts_limit', '4', 'Maximum accounts for free plan'),
  ('free_automations_limit', '5', 'Maximum automation rules for free plan'),
  ('free_categories_limit', '15', 'Maximum categories for free plan');
