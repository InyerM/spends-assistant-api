-- Add import_id FK to transactions table
ALTER TABLE transactions ADD COLUMN import_id UUID REFERENCES imports(id) ON DELETE SET NULL;
CREATE INDEX idx_transactions_import_id ON transactions(import_id) WHERE import_id IS NOT NULL;
