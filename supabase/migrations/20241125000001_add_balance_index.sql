-- Add index for fast balance calculations
CREATE INDEX IF NOT EXISTS idx_transactions_account_balance 
ON transactions(account_id, amount);

-- Add comment for documentation
COMMENT ON INDEX idx_transactions_account_balance IS 'Optimizes SUM queries for account balance calculations';
