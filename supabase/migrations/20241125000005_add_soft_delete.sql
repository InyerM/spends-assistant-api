-- Add soft delete column to all tables
ALTER TABLE accounts ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE categories ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE transactions ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE automation_rules ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE reconciliations ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE imports ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Add indexes for frequently queried tables
CREATE INDEX idx_accounts_deleted_at ON accounts (deleted_at);
CREATE INDEX idx_transactions_deleted_at ON transactions (deleted_at);
