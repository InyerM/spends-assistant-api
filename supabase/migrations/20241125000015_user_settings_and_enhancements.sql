-- ====================================
-- MIGRATION 15: USER SETTINGS & SCHEMA ENHANCEMENTS
-- ====================================

-- 1. User settings table (per-user preferences)
CREATE TABLE user_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  hour_format TEXT NOT NULL DEFAULT '12h' CHECK (hour_format IN ('12h', '24h')),
  show_api_keys BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own_settings" ON user_settings FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "service_role_user_settings" ON user_settings FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE TRIGGER user_settings_updated_at
  BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-create user_settings row on new user signup
CREATE OR REPLACE FUNCTION public.handle_new_user_settings()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_settings (user_id)
  VALUES (NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created_settings
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_settings();

-- 2. Categories: add is_default and spending_nature columns
CREATE TYPE spending_nature AS ENUM ('none', 'want', 'need', 'must');

ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT false;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS spending_nature spending_nature DEFAULT 'none';

-- 3. Accounts: add is_default column
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT false;

-- 4. Automation rules: add ai_prompt audit column
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS ai_prompt TEXT;

COMMENT ON COLUMN automation_rules.ai_prompt IS 'Original AI prompt used to generate this rule (audit trail)';

-- 5. New app_settings rows
INSERT INTO app_settings (key, value, description) VALUES
  ('support_email', '"support@spendsapp.com"', 'Support contact email'),
  ('faq_url', '"https://spendsapp.com/faq"', 'FAQ page URL'),
  ('automation_faq_url', '"https://spendsapp.com/faq/automation"', 'Automation FAQ page URL')
ON CONFLICT (key) DO NOTHING;
