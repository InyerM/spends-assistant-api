-- Run AFTER backfilling user_id on all tables
ALTER TABLE accounts ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE categories ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE transactions ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE automation_rules ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE reconciliations ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE imports ALTER COLUMN user_id SET NOT NULL;
