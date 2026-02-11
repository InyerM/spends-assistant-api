-- Add applied_rules JSONB column to transactions table
-- Stores an array of rules that were applied during transaction creation
-- Example: [{"rule_id": "uuid", "rule_name": "Nequi Transfer", "actions": {"set_type": "transfer"}}]
ALTER TABLE transactions ADD COLUMN applied_rules JSONB DEFAULT NULL;
