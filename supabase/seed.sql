-- Default accounts and categories are owner-scoped and created on signup.
-- The category catalog is maintained in data/default-categories.json and applied
-- by handle_new_user_default_categories. Never truncate categories: transactions,
-- budgets, rules, and reviewed evidence retain their original category IDs.
DO $$ BEGIN RAISE NOTICE 'Create a local test user to load the current owner-scoped defaults.'; END $$;
