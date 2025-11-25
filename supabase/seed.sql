-- ====================================
-- SEED DATA
-- ====================================

-- Insert default accounts
INSERT INTO accounts (name, type, institution, last_four, color, icon) VALUES
('Bancolombia Checking', 'checking', 'bancolombia', '7799', '#FFCC00', '💳'),
('Nequi', 'savings', 'nequi', NULL, '#8B5CF6', '💜'),
('Cash', 'cash', 'cash', NULL, '#10B981', '💵'),
('Bancolombia Credit Card', 'credit_card', 'bancolombia', '1234', '#EF4444', '💳');

-- =============================================
-- CATEGORIES
-- =============================================

-- Clear existing categories
TRUNCATE TABLE categories CASCADE;

-- Food & Drinks
INSERT INTO categories (name, slug, type, icon, color) VALUES
('Food & Drinks', 'food-drinks', 'expense', '🍔', '#FF6B6B'),
('Bar, Cafe', 'bar-cafe', 'expense', '☕', '#FF6B6B'),
('Restaurant, Fast-food', 'restaurant', 'expense', '🍽️', '#FF6B6B'),
('Groceries', 'groceries', 'expense', '🛒', '#FF6B6B');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'food-drinks') 
WHERE slug IN ('bar-cafe', 'restaurant', 'groceries');

-- Shopping
INSERT INTO categories (name, slug, type, icon, color) VALUES
('Shopping', 'shopping', 'expense', '🛍️', '#4ECDC4'),
('Drug-store, Chemist', 'drugstore', 'expense', '💊', '#4ECDC4'),
('Leisure Time', 'leisure', 'expense', '🎮', '#4ECDC4'),
('Stationery, Tools', 'stationery', 'expense', '✏️', '#4ECDC4'),
('Gifts, Joy', 'gifts', 'expense', '🎁', '#4ECDC4'),
('Electronics, Accessories', 'electronics', 'expense', '📱', '#4ECDC4'),
('Pets, Animals', 'pets', 'expense', '🐕', '#4ECDC4'),
('Home, Garden', 'home-garden', 'expense', '🏡', '#4ECDC4'),
('Kids', 'kids', 'expense', '👶', '#4ECDC4'),
('Health and Beauty', 'health-beauty', 'expense', '💄', '#4ECDC4'),
('Jewels, Accessories', 'jewels', 'expense', '💎', '#4ECDC4'),
('Clothes & Footwear', 'clothes', 'expense', '👕', '#4ECDC4');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'shopping') 
WHERE slug IN ('drugstore', 'leisure', 'stationery', 'gifts', 'electronics', 'pets', 'home-garden', 'kids', 'health-beauty', 'jewels', 'clothes');

-- Housing
INSERT INTO categories (name, slug, type, icon, color) VALUES
('Housing', 'housing', 'expense', '🏠', '#95E1D3'),
('Property Insurance', 'property-insurance', 'expense', '🛡️', '#95E1D3'),
('Maintenance, Repairs', 'maintenance', 'expense', '🔧', '#95E1D3'),
('Services', 'housing-services', 'expense', '🔌', '#95E1D3'),
('Energy, Utilities', 'utilities', 'expense', '💡', '#95E1D3'),
('Mortgage', 'mortgage', 'expense', '🏦', '#95E1D3'),
('Rent', 'rent', 'expense', '🔑', '#95E1D3');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'housing') 
WHERE slug IN ('property-insurance', 'maintenance', 'housing-services', 'utilities', 'mortgage', 'rent');

-- Transportation
INSERT INTO categories (name, slug, type, icon, color) VALUES
('Transportation', 'transportation', 'expense', '🚗', '#F38181'),
('Business Trips', 'business-trips', 'expense', '✈️', '#F38181'),
('Long Distance', 'long-distance', 'expense', '🚄', '#F38181'),
('Taxi', 'taxi', 'expense', '🚕', '#F38181'),
('Public Transport', 'public-transport', 'expense', '🚌', '#F38181');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'transportation') 
WHERE slug IN ('business-trips', 'long-distance', 'taxi', 'public-transport');

-- Vehicle
INSERT INTO categories (name, slug, type, icon, color) VALUES
('Vehicle', 'vehicle', 'expense', '🚙', '#AA96DA'),
('Leasing', 'leasing', 'expense', '📋', '#AA96DA'),
('Vehicle Insurance', 'vehicle-insurance', 'expense', '🛡️', '#AA96DA'),
('Rentals', 'vehicle-rentals', 'expense', '🔑', '#AA96DA'),
('Vehicle Maintenance', 'vehicle-maintenance', 'expense', '🔧', '#AA96DA'),
('Parking', 'parking', 'expense', '🅿️', '#AA96DA'),
('Fuel', 'fuel', 'expense', '⛽', '#AA96DA');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'vehicle') 
WHERE slug IN ('leasing', 'vehicle-insurance', 'vehicle-rentals', 'vehicle-maintenance', 'parking', 'fuel');

-- Life & Entertainment
INSERT INTO categories (name, slug, type, icon, color) VALUES
('Life & Entertainment', 'entertainment', 'expense', '🎬', '#FCBAD3'),
('Lottery, Gambling', 'lottery', 'expense', '🎰', '#FCBAD3'),
('Alcohol, Tobacco', 'alcohol-tobacco', 'expense', '🍷', '#FCBAD3'),
('Charity, Gifts', 'charity', 'expense', '❤️', '#FCBAD3'),
('Holiday, Trips, Hotels', 'holiday', 'expense', '🏖️', '#FCBAD3'),
('TV, Streaming', 'streaming', 'expense', '📺', '#FCBAD3'),
('Books, Audio, Subscriptions', 'subscriptions', 'expense', '📚', '#FCBAD3'),
('Education, Development', 'education', 'expense', '📖', '#FCBAD3'),
('Hobbies', 'hobbies', 'expense', '🎨', '#FCBAD3'),
('Life Events', 'life-events', 'expense', '🎉', '#FCBAD3'),
('Culture, Sport Events', 'culture-events', 'expense', '🎭', '#FCBAD3'),
('Active Sport, Fitness', 'fitness', 'expense', '💪', '#FCBAD3'),
('Wellness, Beauty', 'wellness', 'expense', '💆', '#FCBAD3'),
('Health Care, Doctor', 'health-care', 'expense', '⚕️', '#FCBAD3');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'entertainment') 
WHERE slug IN ('lottery', 'alcohol-tobacco', 'charity', 'holiday', 'streaming', 'subscriptions', 'education', 'hobbies', 'life-events', 'culture-events', 'fitness', 'wellness', 'health-care');

-- Communication, PC
INSERT INTO categories (name, slug, type, icon, color) VALUES
('Communication, PC', 'communication', 'expense', '💻', '#FFFFD2'),
('Postal Services', 'postal', 'expense', '📮', '#FFFFD2'),
('Software, Apps, Games', 'software', 'expense', '🎮', '#FFFFD2'),
('Internet', 'internet', 'expense', '🌐', '#FFFFD2'),
('Telephony, Mobile Phone', 'phone', 'expense', '📱', '#FFFFD2');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'communication') 
WHERE slug IN ('postal', 'software', 'internet', 'phone');

-- Financial Expenses
INSERT INTO categories (name, slug, type, icon, color) VALUES
('Financial Expenses', 'financial', 'expense', '💰', '#A8D8EA'),
('Child Support', 'child-support-expense', 'expense', '👶', '#A8D8EA'),
('Charges, Fees', 'fees', 'expense', '💵', '#A8D8EA'),
('Advisory', 'advisory', 'expense', '📊', '#A8D8EA'),
('Fines', 'fines', 'expense', '🚫', '#A8D8EA'),
('Loans, Interests', 'loans', 'expense', '🏦', '#A8D8EA'),
('Insurances', 'insurances', 'expense', '🛡️', '#A8D8EA'),
('Taxes', 'taxes', 'expense', '📋', '#A8D8EA');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'financial') 
WHERE slug IN ('child-support-expense', 'fees', 'advisory', 'fines', 'loans', 'insurances', 'taxes');

-- Investments
INSERT INTO categories (name, slug, type, icon, color) VALUES
('Investments', 'investments', 'expense', '📊', '#845EC2'),
('Collections', 'collections', 'expense', '🖼️', '#845EC2'),
('Savings', 'savings-category', 'expense', '🏦', '#845EC2'),
('Financial Investments', 'financial-investments', 'expense', '📈', '#845EC2'),
('Vehicles, Chattels', 'vehicles-chattels', 'expense', '🚗', '#845EC2'),
('Realty', 'realty', 'expense', '🏢', '#845EC2');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'investments') 
WHERE slug IN ('collections', 'savings-category', 'financial-investments', 'vehicles-chattels', 'realty');

-- Income Categories
INSERT INTO categories (name, slug, type, icon, color) VALUES
('Income', 'income', 'income', '💵', '#51CF66'),
('Gifts (Income)', 'gifts-income', 'income', '🎁', '#51CF66'),
('Child Support (Income)', 'child-support-income', 'income', '👶', '#51CF66'),
('Refunds', 'refunds', 'income', '↩️', '#51CF66'),
('Lottery, Gambling (Income)', 'lottery-income', 'income', '🎰', '#51CF66'),
('Checks, Coupons', 'checks', 'income', '🎫', '#51CF66'),
('Lending, Renting', 'lending', 'income', '🤝', '#51CF66'),
('Dues & Grants', 'grants', 'income', '🎓', '#51CF66'),
('Rental Income', 'rental-income', 'income', '🏠', '#51CF66'),
('Sale', 'sale', 'income', '💰', '#51CF66'),
('Interests, Dividends', 'dividends', 'income', '📈', '#51CF66'),
('Wage, Invoices', 'wage', 'income', '💼', '#51CF66');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'income') 
WHERE slug IN ('gifts-income', 'child-support-income', 'refunds', 'lottery-income', 'checks', 'lending', 'grants', 'rental-income', 'sale', 'dividends', 'wage');

-- Others
INSERT INTO categories (name, slug, type, icon, color) VALUES
('Others', 'others', 'expense', '❓', '#95A5A6'),
('Missing', 'missing', 'expense', '❌', '#95A5A6');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'others') 
WHERE slug IN ('missing');

-- Transfer category
INSERT INTO categories (name, slug, type, icon, color) VALUES
('Transfer', 'transfer', 'transfer', '↔️', '#6B7280');

-- =============================================
-- AUTOMATION RULES
-- =============================================

-- Insert automation rule for Bancolombia → Nequi transfers
INSERT INTO automation_rules (name, priority, conditions, actions) 
SELECT 
  'Detect Bancolombia to Nequi Transfer',
  100,
  jsonb_build_object(
    'description_contains', ARRAY['transferencia', 'envío', 'enviaste', 'transfer'],
    'from_account', bancolombia.id
  ),
  jsonb_build_object(
    'set_type', 'transfer',
    'set_category', transfer_cat.id,
    'link_to_account', nequi.id,
    'auto_reconcile', true
  )
FROM 
  accounts bancolombia,
  accounts nequi,
  categories transfer_cat
WHERE 
  bancolombia.institution = 'bancolombia' 
  AND bancolombia.type = 'checking'
  AND nequi.institution = 'nequi'
  AND transfer_cat.slug = 'transfer';
