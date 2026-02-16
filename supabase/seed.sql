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
INSERT INTO categories (name, slug, type, icon, color, translations) VALUES
('Food & Drinks', 'food-drinks', 'expense', '🍔', '#FF6B6B', '{"en": "Food & Drinks", "es": "Comida y Bebidas", "pt": "Comida e Bebidas"}'),
('Bar, Cafe', 'bar-cafe', 'expense', '☕', '#FF6B6B', '{"en": "Bar, Cafe", "es": "Bar, Cafe", "pt": "Bar, Cafe"}'),
('Restaurant, Fast-food', 'restaurant', 'expense', '🍽️', '#FF6B6B', '{"en": "Restaurant, Fast-food", "es": "Restaurante, Comida rapida", "pt": "Restaurante, Fast-food"}'),
('Groceries', 'groceries', 'expense', '🛒', '#FF6B6B', '{"en": "Groceries", "es": "Supermercado", "pt": "Supermercado"}'),
('Delivery', 'delivery', 'expense', '🛵', '#FF9F43', '{"en": "Delivery", "es": "Domicilios", "pt": "Delivery"}');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'food-drinks')
WHERE slug IN ('bar-cafe', 'restaurant', 'groceries', 'delivery');

-- Shopping
INSERT INTO categories (name, slug, type, icon, color, translations) VALUES
('Shopping', 'shopping', 'expense', '🛍️', '#4ECDC4', '{"en": "Shopping", "es": "Compras", "pt": "Compras"}'),
('Drug-store, Chemist', 'drugstore', 'expense', '💊', '#4ECDC4', '{"en": "Drug-store, Chemist", "es": "Farmacia, Drogueria", "pt": "Farmacia, Drogaria"}'),
('Gaming & Hobbies', 'gaming-hobbies', 'expense', '🎮', '#4ECDC4', '{"en": "Gaming & Hobbies", "es": "Videojuegos y Pasatiempos", "pt": "Jogos e Hobbies"}'),
('Stationery, Tools', 'stationery', 'expense', '✏️', '#4ECDC4', '{"en": "Stationery, Tools", "es": "Papeleria, Herramientas", "pt": "Papelaria, Ferramentas"}'),
('Gifts, Joy', 'gifts', 'expense', '🎁', '#4ECDC4', '{"en": "Gifts, Joy", "es": "Regalos, Alegria", "pt": "Presentes, Alegria"}'),
('Electronics, Accessories', 'electronics', 'expense', '📱', '#4ECDC4', '{"en": "Electronics, Accessories", "es": "Electronica, Accesorios", "pt": "Eletronica, Acessorios"}'),
('Pets, Animals', 'pets', 'expense', '🐕', '#4ECDC4', '{"en": "Pets, Animals", "es": "Mascotas, Animales", "pt": "Animais de Estimacao"}'),
('Home, Garden', 'home-garden', 'expense', '🏡', '#4ECDC4', '{"en": "Home, Garden", "es": "Hogar, Jardin", "pt": "Casa, Jardim"}'),
('Kids', 'kids', 'expense', '👶', '#4ECDC4', '{"en": "Kids", "es": "Ninos", "pt": "Criancas"}'),
('Health and Beauty', 'health-beauty', 'expense', '💄', '#4ECDC4', '{"en": "Health and Beauty", "es": "Salud y Belleza", "pt": "Saude e Beleza"}'),
('Jewels, Accessories', 'jewels', 'expense', '💎', '#4ECDC4', '{"en": "Jewels, Accessories", "es": "Joyas, Accesorios", "pt": "Joias, Acessorios"}'),
('Clothes & Footwear', 'clothes', 'expense', '👕', '#4ECDC4', '{"en": "Clothes & Footwear", "es": "Ropa y Calzado", "pt": "Roupas e Calcados"}');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'shopping')
WHERE slug IN ('drugstore', 'gaming-hobbies', 'stationery', 'gifts', 'electronics', 'pets', 'home-garden', 'kids', 'health-beauty', 'jewels', 'clothes');

-- Housing
INSERT INTO categories (name, slug, type, icon, color, translations) VALUES
('Housing', 'housing', 'expense', '🏠', '#95E1D3', '{"en": "Housing", "es": "Vivienda", "pt": "Moradia"}'),
('Property Insurance', 'property-insurance', 'expense', '🛡️', '#95E1D3', '{"en": "Property Insurance", "es": "Seguro de Propiedad", "pt": "Seguro de Propriedade"}'),
('Maintenance, Repairs', 'maintenance', 'expense', '🔧', '#95E1D3', '{"en": "Maintenance, Repairs", "es": "Mantenimiento, Reparaciones", "pt": "Manutencao, Reparos"}'),
('Services', 'housing-services', 'expense', '🔌', '#95E1D3', '{"en": "Services", "es": "Servicios", "pt": "Servicos"}'),
('Energy, Utilities', 'utilities', 'expense', '💡', '#95E1D3', '{"en": "Energy, Utilities", "es": "Energia, Servicios publicos", "pt": "Energia, Servicos publicos"}'),
('Mortgage', 'mortgage', 'expense', '🏦', '#95E1D3', '{"en": "Mortgage", "es": "Hipoteca", "pt": "Hipoteca"}'),
('Rent', 'rent', 'expense', '🔑', '#95E1D3', '{"en": "Rent", "es": "Arriendo", "pt": "Aluguel"}');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'housing')
WHERE slug IN ('property-insurance', 'maintenance', 'housing-services', 'utilities', 'mortgage', 'rent');

-- Transportation
INSERT INTO categories (name, slug, type, icon, color, translations) VALUES
('Transportation', 'transportation', 'expense', '🚗', '#F38181', '{"en": "Transportation", "es": "Transporte", "pt": "Transporte"}'),
('Business Trips', 'business-trips', 'expense', '✈️', '#F38181', '{"en": "Business Trips", "es": "Viajes de Negocios", "pt": "Viagens de Negocios"}'),
('Long Distance', 'long-distance', 'expense', '🚄', '#F38181', '{"en": "Long Distance", "es": "Larga Distancia", "pt": "Longa Distancia"}'),
('Taxi', 'taxi', 'expense', '🚕', '#F38181', '{"en": "Taxi", "es": "Taxi", "pt": "Taxi"}'),
('Public Transport', 'public-transport', 'expense', '🚌', '#F38181', '{"en": "Public Transport", "es": "Transporte publico", "pt": "Transporte publico"}');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'transportation')
WHERE slug IN ('business-trips', 'long-distance', 'taxi', 'public-transport');

-- Vehicle
INSERT INTO categories (name, slug, type, icon, color, translations) VALUES
('Vehicle', 'vehicle', 'expense', '🚙', '#AA96DA', '{"en": "Vehicle", "es": "Vehiculo", "pt": "Veiculo"}'),
('Leasing', 'leasing', 'expense', '📋', '#AA96DA', '{"en": "Leasing", "es": "Leasing", "pt": "Leasing"}'),
('Vehicle Insurance', 'vehicle-insurance', 'expense', '🛡️', '#AA96DA', '{"en": "Vehicle Insurance", "es": "Seguro de Vehiculo", "pt": "Seguro de Veiculo"}'),
('Rentals', 'vehicle-rentals', 'expense', '🔑', '#AA96DA', '{"en": "Rentals", "es": "Alquiler", "pt": "Aluguel"}'),
('Vehicle Maintenance', 'vehicle-maintenance', 'expense', '🔧', '#AA96DA', '{"en": "Vehicle Maintenance", "es": "Mantenimiento de Vehiculo", "pt": "Manutencao de Veiculo"}'),
('Parking', 'parking', 'expense', '🅿️', '#AA96DA', '{"en": "Parking", "es": "Estacionamiento", "pt": "Estacionamento"}'),
('Fuel', 'fuel', 'expense', '⛽', '#AA96DA', '{"en": "Fuel", "es": "Combustible", "pt": "Combustivel"}');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'vehicle')
WHERE slug IN ('leasing', 'vehicle-insurance', 'vehicle-rentals', 'vehicle-maintenance', 'parking', 'fuel');

-- Life & Entertainment
-- NOTE: charity MOVED to Others, streaming+subscriptions MERGED into "Subscriptions & Streaming"
INSERT INTO categories (name, slug, type, icon, color, translations) VALUES
('Life & Entertainment', 'entertainment', 'expense', '🎬', '#FCBAD3', '{"en": "Life & Entertainment", "es": "Vida y Entretenimiento", "pt": "Vida e Entretenimento"}'),
('Lottery, Gambling', 'lottery', 'expense', '🎰', '#FCBAD3', '{"en": "Lottery, Gambling", "es": "Loteria, Apuestas", "pt": "Loteria, Apostas"}'),
('Alcohol, Tobacco', 'alcohol-tobacco', 'expense', '🍷', '#FCBAD3', '{"en": "Alcohol, Tobacco", "es": "Alcohol, Tabaco", "pt": "Alcool, Tabaco"}'),
('Holiday, Trips, Hotels', 'holiday', 'expense', '🏖️', '#FCBAD3', '{"en": "Holiday, Trips, Hotels", "es": "Vacaciones, Viajes, Hoteles", "pt": "Ferias, Viagens, Hoteis"}'),
('Subscriptions & Streaming', 'subscriptions', 'expense', '📺', '#FCBAD3', '{"en": "Subscriptions & Streaming", "es": "Suscripciones y Streaming", "pt": "Assinaturas e Streaming"}'),
('Education, Development', 'education', 'expense', '📖', '#FCBAD3', '{"en": "Education, Development", "es": "Educacion, Desarrollo", "pt": "Educacao, Desenvolvimento"}'),
('Hobbies', 'hobbies', 'expense', '🎨', '#FCBAD3', '{"en": "Hobbies", "es": "Pasatiempos", "pt": "Hobbies"}'),
('Life Events', 'life-events', 'expense', '🎉', '#FCBAD3', '{"en": "Life Events", "es": "Eventos de Vida", "pt": "Eventos da Vida"}'),
('Culture, Sport Events', 'culture-events', 'expense', '🎭', '#FCBAD3', '{"en": "Culture, Sport Events", "es": "Cultura, Eventos deportivos", "pt": "Cultura, Eventos esportivos"}'),
('Active Sport, Fitness', 'fitness', 'expense', '💪', '#FCBAD3', '{"en": "Active Sport, Fitness", "es": "Deporte, Fitness", "pt": "Esporte, Fitness"}'),
('Wellness, Beauty', 'wellness', 'expense', '💆', '#FCBAD3', '{"en": "Wellness, Beauty", "es": "Bienestar, Belleza", "pt": "Bem-estar, Beleza"}'),
('Health Care, Doctor', 'health-care', 'expense', '⚕️', '#FCBAD3', '{"en": "Health Care, Doctor", "es": "Salud, Medico", "pt": "Saude, Medico"}'),
('Personal Care', 'personal-care', 'expense', '💇', '#FDA7DF', '{"en": "Personal Care", "es": "Cuidado personal", "pt": "Cuidados pessoais"}');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'entertainment')
WHERE slug IN ('lottery', 'alcohol-tobacco', 'holiday', 'subscriptions', 'education', 'hobbies', 'life-events', 'culture-events', 'fitness', 'wellness', 'health-care', 'personal-care');

-- Technology & Internet (renamed from "Communication, PC")
INSERT INTO categories (name, slug, type, icon, color, translations) VALUES
('Technology & Internet', 'technology', 'expense', '💻', '#FFFFD2', '{"en": "Technology & Internet", "es": "Tecnologia e Internet", "pt": "Tecnologia e Internet"}'),
('Postal Services', 'postal', 'expense', '📮', '#FFFFD2', '{"en": "Postal Services", "es": "Servicios postales", "pt": "Servicos postais"}'),
('Software, Apps, Games', 'software', 'expense', '🎮', '#FFFFD2', '{"en": "Software, Apps, Games", "es": "Software, Apps, Juegos", "pt": "Software, Apps, Jogos"}'),
('Internet', 'internet', 'expense', '🌐', '#FFFFD2', '{"en": "Internet", "es": "Internet", "pt": "Internet"}'),
('Telephony, Mobile Phone', 'phone', 'expense', '📱', '#FFFFD2', '{"en": "Telephony, Mobile Phone", "es": "Telefonia, Celular", "pt": "Telefonia, Celular"}'),
('Cloud Services', 'cloud-services', 'expense', '☁️', '#74B9FF', '{"en": "Cloud Services", "es": "Servicios en la nube", "pt": "Servicos em nuvem"}');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'technology')
WHERE slug IN ('postal', 'software', 'internet', 'phone', 'cloud-services');

-- Financial Expenses
INSERT INTO categories (name, slug, type, icon, color, translations) VALUES
('Financial Expenses', 'financial', 'expense', '💰', '#A8D8EA', '{"en": "Financial Expenses", "es": "Gastos Financieros", "pt": "Despesas Financeiras"}'),
('Child Support', 'child-support-expense', 'expense', '👶', '#A8D8EA', '{"en": "Child Support", "es": "Pension alimenticia", "pt": "Pensao alimenticia"}'),
('Charges, Fees', 'fees', 'expense', '💵', '#A8D8EA', '{"en": "Charges, Fees", "es": "Cargos, Comisiones", "pt": "Taxas, Tarifas"}'),
('Advisory', 'advisory', 'expense', '📊', '#A8D8EA', '{"en": "Advisory", "es": "Asesoria", "pt": "Consultoria"}'),
('Fines', 'fines', 'expense', '🚫', '#A8D8EA', '{"en": "Fines", "es": "Multas", "pt": "Multas"}'),
('Loans, Interests', 'loans', 'expense', '🏦', '#A8D8EA', '{"en": "Loans, Interests", "es": "Prestamos, Intereses", "pt": "Emprestimos, Juros"}'),
('Insurances', 'insurances', 'expense', '🛡️', '#A8D8EA', '{"en": "Insurances", "es": "Seguros", "pt": "Seguros"}'),
('Taxes', 'taxes', 'expense', '📋', '#A8D8EA', '{"en": "Taxes", "es": "Impuestos", "pt": "Impostos"}'),
('Debt Payment', 'debt-payment', 'expense', '💳', '#E17055', '{"en": "Debt Payment", "es": "Pago de deuda", "pt": "Pagamento de divida"}');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'financial')
WHERE slug IN ('child-support-expense', 'fees', 'advisory', 'fines', 'loans', 'insurances', 'taxes', 'debt-payment');

-- Investments
INSERT INTO categories (name, slug, type, icon, color, translations) VALUES
('Investments', 'investments', 'expense', '📊', '#845EC2', '{"en": "Investments", "es": "Inversiones", "pt": "Investimentos"}'),
('Art & Collectibles', 'art-collectibles', 'expense', '🖼️', '#845EC2', '{"en": "Art & Collectibles", "es": "Arte y Coleccionables", "pt": "Arte e Colecionaveis"}'),
('Savings', 'savings-category', 'expense', '🏦', '#845EC2', '{"en": "Savings", "es": "Ahorros", "pt": "Poupanca"}'),
('Financial Investments', 'financial-investments', 'expense', '📈', '#845EC2', '{"en": "Financial Investments", "es": "Inversiones financieras", "pt": "Investimentos financeiros"}'),
('Vehicle Investments', 'vehicle-investments', 'expense', '🚗', '#845EC2', '{"en": "Vehicle Investments", "es": "Inversiones en Vehiculos", "pt": "Investimentos em Veiculos"}'),
('Realty', 'realty', 'expense', '🏢', '#845EC2', '{"en": "Realty", "es": "Bienes raices", "pt": "Imoveis"}');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'investments')
WHERE slug IN ('art-collectibles', 'savings-category', 'financial-investments', 'vehicle-investments', 'realty');

-- Income Categories
INSERT INTO categories (name, slug, type, icon, color, translations) VALUES
('Income', 'income', 'income', '💵', '#51CF66', '{"en": "Income", "es": "Ingresos", "pt": "Renda"}'),
('Gifts (Income)', 'gifts-income', 'income', '🎁', '#51CF66', '{"en": "Gifts (Income)", "es": "Regalos (Ingreso)", "pt": "Presentes (Renda)"}'),
('Child Support (Income)', 'child-support-income', 'income', '👶', '#51CF66', '{"en": "Child Support (Income)", "es": "Pension alimenticia (Ingreso)", "pt": "Pensao alimenticia (Renda)"}'),
('Refunds', 'refunds', 'income', '↩️', '#51CF66', '{"en": "Refunds", "es": "Reembolsos", "pt": "Reembolsos"}'),
('Lottery, Gambling (Income)', 'lottery-income', 'income', '🎰', '#51CF66', '{"en": "Lottery, Gambling (Income)", "es": "Loteria, Apuestas (Ingreso)", "pt": "Loteria, Apostas (Renda)"}'),
('Checks, Coupons', 'checks', 'income', '🎫', '#51CF66', '{"en": "Checks, Coupons", "es": "Cheques, Cupones", "pt": "Cheques, Cupons"}'),
('Lending, Renting', 'lending', 'income', '🤝', '#51CF66', '{"en": "Lending, Renting", "es": "Prestamos, Alquiler", "pt": "Emprestimos, Aluguel"}'),
('Dues & Grants', 'grants', 'income', '🎓', '#51CF66', '{"en": "Dues & Grants", "es": "Cuotas y Becas", "pt": "Cotas e Bolsas"}'),
('Rental Income', 'rental-income', 'income', '🏠', '#51CF66', '{"en": "Rental Income", "es": "Ingresos por Alquiler", "pt": "Renda de Aluguel"}'),
('Sale', 'sale', 'income', '💰', '#51CF66', '{"en": "Sale", "es": "Venta", "pt": "Venda"}'),
('Interests, Dividends', 'dividends', 'income', '📈', '#51CF66', '{"en": "Interests, Dividends", "es": "Intereses, Dividendos", "pt": "Juros, Dividendos"}'),
('Wage, Invoices', 'wage', 'income', '💼', '#51CF66', '{"en": "Wage, Invoices", "es": "Salario, Facturas", "pt": "Salario, Faturas"}');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'income')
WHERE slug IN ('gifts-income', 'child-support-income', 'refunds', 'lottery-income', 'checks', 'lending', 'grants', 'rental-income', 'sale', 'dividends', 'wage');

-- Others
-- NOTE: charity MOVED here from Entertainment, missing RENAMED to Uncategorized
INSERT INTO categories (name, slug, type, icon, color, translations) VALUES
('Others', 'others', 'expense', '❓', '#95A5A6', '{"en": "Others", "es": "Otros", "pt": "Outros"}'),
('Uncategorized', 'uncategorized', 'expense', '❌', '#95A5A6', '{"en": "Uncategorized", "es": "Sin categoria", "pt": "Sem categoria"}'),
('Charity, Gifts', 'charity', 'expense', '❤️', '#95A5A6', '{"en": "Charity, Gifts", "es": "Caridad, Donaciones", "pt": "Caridade, Doacoes"}');

UPDATE categories SET parent_id = (SELECT id FROM categories WHERE slug = 'others')
WHERE slug IN ('uncategorized', 'charity');

-- Transfer category
INSERT INTO categories (name, slug, type, icon, color, translations) VALUES
('Transfer', 'transfer', 'transfer', '↔️', '#6B7280', '{"en": "Transfer", "es": "Transferencia", "pt": "Transferencia"}');

-- =============================================
-- AUTOMATION RULES
-- =============================================

-- Example: Transfer to personal Nequi account by phone number
-- Replace '3104633357' with your actual Nequi phone number
INSERT INTO automation_rules (
  name,
  priority,
  is_active,
  prompt_text,
  match_phone,
  transfer_to_account_id,
  conditions,
  actions
)
SELECT
  'Transfer to Personal Nequi',
  200,
  true,
  'If transferring to phone *3104633357, categorize as internal transfer to Nequi account',
  '3104633357',
  nequi.id,
  jsonb_build_object('contains_text', ARRAY['Transferiste', '*3104633357']),
  jsonb_build_object('set_category', transfer_cat.id, 'link_account', nequi.id)
FROM accounts nequi, categories transfer_cat
WHERE nequi.institution = 'nequi' AND transfer_cat.slug = 'transfer'
ON CONFLICT DO NOTHING;
