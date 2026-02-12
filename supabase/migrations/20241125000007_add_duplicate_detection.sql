-- Add duplicate detection columns to transactions table
-- duplicate_status: null (normal), 'pending_review' (flagged), 'confirmed' (user kept both)
-- duplicate_of: references the original transaction that triggered the match
ALTER TABLE transactions ADD COLUMN duplicate_status TEXT DEFAULT NULL;
ALTER TABLE transactions ADD COLUMN duplicate_of UUID REFERENCES transactions(id) DEFAULT NULL;

-- Partial index for efficient queries on flagged duplicates
CREATE INDEX idx_transactions_duplicate_status ON transactions (duplicate_status) WHERE duplicate_status IS NOT NULL;
