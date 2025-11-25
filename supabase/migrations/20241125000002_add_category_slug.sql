-- Add slug column to categories table
ALTER TABLE categories ADD COLUMN slug VARCHAR(100) UNIQUE;

-- Add index for faster lookups
CREATE INDEX idx_categories_slug ON categories(slug);

-- Update existing categories to have slugs (will be replaced by new seed)
UPDATE categories SET slug = LOWER(REPLACE(name, ' ', '-'));

-- Make slug required after initial data migration
ALTER TABLE categories ALTER COLUMN slug SET NOT NULL;
