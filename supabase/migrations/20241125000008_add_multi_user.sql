-- ====================================
-- MULTI-USER SUPPORT: Add user_id columns, user_api_keys table, indexes, and RLS policies
-- ====================================

-- 1A. Add user_id column to all 6 data tables (nullable initially for backfill)
ALTER TABLE accounts ADD COLUMN user_id UUID REFERENCES auth.users(id);
ALTER TABLE categories ADD COLUMN user_id UUID REFERENCES auth.users(id);
ALTER TABLE transactions ADD COLUMN user_id UUID REFERENCES auth.users(id);
ALTER TABLE automation_rules ADD COLUMN user_id UUID REFERENCES auth.users(id);
ALTER TABLE reconciliations ADD COLUMN user_id UUID REFERENCES auth.users(id);
ALTER TABLE imports ADD COLUMN user_id UUID REFERENCES auth.users(id);

-- 1B. Create user_api_keys table
CREATE TABLE user_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL DEFAULT 'Default',
  is_active BOOLEAN DEFAULT true,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE user_api_keys ENABLE ROW LEVEL SECURITY;

-- 1C. Indexes (per Supabase best practices: always index FK + RLS columns)
CREATE INDEX idx_accounts_user_id ON accounts (user_id);
CREATE INDEX idx_categories_user_id ON categories (user_id);
CREATE INDEX idx_transactions_user_id_date ON transactions (user_id, date DESC);
CREATE INDEX idx_automation_rules_user_id ON automation_rules (user_id);
CREATE INDEX idx_reconciliations_user_id ON reconciliations (user_id);
CREATE INDEX idx_imports_user_id ON imports (user_id);
CREATE INDEX idx_user_api_keys_hash ON user_api_keys (key_hash) WHERE is_active = true;

-- 1D. Drop old RLS policies and create new ones
-- Per Supabase RLS performance best practice: wrap auth.uid() in (select ...)
-- so it's called once per query, not per row.

-- accounts
DROP POLICY IF EXISTS "Service role has full access to accounts" ON accounts;
CREATE POLICY "users_own_accounts" ON accounts
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "service_role_accounts" ON accounts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- categories
DROP POLICY IF EXISTS "Service role has full access to categories" ON categories;
CREATE POLICY "users_own_categories" ON categories
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "service_role_categories" ON categories
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- transactions
DROP POLICY IF EXISTS "Service role has full access to transactions" ON transactions;
CREATE POLICY "users_own_transactions" ON transactions
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "service_role_transactions" ON transactions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- automation_rules
DROP POLICY IF EXISTS "Service role has full access to automation_rules" ON automation_rules;
CREATE POLICY "users_own_automation_rules" ON automation_rules
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "service_role_automation_rules" ON automation_rules
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- reconciliations
DROP POLICY IF EXISTS "Service role has full access to reconciliations" ON reconciliations;
CREATE POLICY "users_own_reconciliations" ON reconciliations
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "service_role_reconciliations" ON reconciliations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- imports
DROP POLICY IF EXISTS "Service role has full access to imports" ON imports;
CREATE POLICY "users_own_imports" ON imports
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "service_role_imports" ON imports
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- user_api_keys
CREATE POLICY "users_own_api_keys" ON user_api_keys
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "service_role_api_keys" ON user_api_keys
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 1E. Backfill script (run manually after migration)
-- Replace <USER_UUID> with actual Supabase user ID:
--
-- UPDATE accounts SET user_id = '<USER_UUID>' WHERE user_id IS NULL;
-- UPDATE categories SET user_id = '<USER_UUID>' WHERE user_id IS NULL;
-- UPDATE transactions SET user_id = '<USER_UUID>' WHERE user_id IS NULL;
-- UPDATE automation_rules SET user_id = '<USER_UUID>' WHERE user_id IS NULL;
-- UPDATE reconciliations SET user_id = '<USER_UUID>' WHERE user_id IS NULL;
-- UPDATE imports SET user_id = '<USER_UUID>' WHERE user_id IS NULL;
