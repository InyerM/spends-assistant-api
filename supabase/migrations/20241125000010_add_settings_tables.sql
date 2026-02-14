-- 1. User sessions
CREATE TABLE user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_name TEXT,
  device_type TEXT,
  browser TEXT,
  os TEXT,
  ip_address INET,
  last_active_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_user_sessions_user_id ON user_sessions (user_id);
CREATE POLICY "users_own_sessions" ON user_sessions FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "service_role_sessions" ON user_sessions FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- 2. Subscriptions
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled', 'past_due')),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_subscriptions_user_id ON subscriptions (user_id);
CREATE POLICY "users_own_subscriptions" ON subscriptions FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "service_role_subscriptions" ON subscriptions FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- 3. Usage tracking (monthly counters)
CREATE TABLE usage_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  ai_parses_used INT NOT NULL DEFAULT 0,
  ai_parses_limit INT NOT NULL DEFAULT 15,
  transactions_count INT NOT NULL DEFAULT 0,
  transactions_limit INT NOT NULL DEFAULT 50,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, month)
);
ALTER TABLE usage_tracking ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_usage_tracking_user_month ON usage_tracking (user_id, month);
CREATE POLICY "users_own_usage" ON usage_tracking FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "service_role_usage" ON usage_tracking FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- 4. Auto-create free subscription on new user signup
CREATE OR REPLACE FUNCTION public.handle_new_user_subscription()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.subscriptions (user_id, plan, status)
  VALUES (NEW.id, 'free', 'active');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created_subscription
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_subscription();
