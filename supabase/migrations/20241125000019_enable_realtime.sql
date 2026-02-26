-- ====================================
-- ENABLE SUPABASE REALTIME
-- ====================================
-- Adds synced tables to the supabase_realtime publication
-- so the mobile app receives live change notifications
-- and can trigger incremental sync automatically.

ALTER PUBLICATION supabase_realtime ADD TABLE transactions;
ALTER PUBLICATION supabase_realtime ADD TABLE accounts;
ALTER PUBLICATION supabase_realtime ADD TABLE categories;
ALTER PUBLICATION supabase_realtime ADD TABLE automation_rules;
ALTER PUBLICATION supabase_realtime ADD TABLE imports;
