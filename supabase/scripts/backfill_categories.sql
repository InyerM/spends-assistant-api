-- ============================================================
-- BACKFILL CATEGORIES FOR EXISTING USER
-- Run with: psql -v target_user_id="'<UUID>'" -f backfill_categories.sql
-- Or replace :target_user_id below with the actual UUID string.
--
-- What it does:
--   - For categories that already exist (matched by slug + user_id):
--     Updates is_default, spending_nature, icon, color, translations
--     Does NOT change name (user may have customized it)
--   - For categories that don't exist: inserts them fresh
--   - Correctly wires parent_id for child categories
-- ============================================================

DO $$
DECLARE
  v_user_id UUID := :target_user_id;
  v_parent_id UUID;
  rec RECORD;
BEGIN
  -- =========================================
  -- TEMP TABLE: define all seed categories
  -- =========================================
  CREATE TEMP TABLE _seed_categories (
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    icon TEXT,
    color TEXT,
    spending_nature TEXT NOT NULL DEFAULT 'none',
    translations JSONB NOT NULL DEFAULT '{}',
    parent_slug TEXT -- NULL for parents
  ) ON COMMIT DROP;

  -- ---- PARENTS ----
  INSERT INTO _seed_categories (slug, name, type, icon, color, spending_nature, translations) VALUES
    ('food-drinks',    'Food & Drinks',          'expense',  '🍔', '#FF6B6B', 'need', '{"en": "Food & Drinks", "es": "Comida y Bebidas", "pt": "Comida e Bebidas"}'),
    ('shopping',       'Shopping',               'expense',  '🛍️', '#4ECDC4', 'want', '{"en": "Shopping", "es": "Compras", "pt": "Compras"}'),
    ('housing',        'Housing',                'expense',  '🏠', '#95E1D3', 'must', '{"en": "Housing", "es": "Vivienda", "pt": "Moradia"}'),
    ('transportation', 'Transportation',         'expense',  '🚗', '#F38181', 'need', '{"en": "Transportation", "es": "Transporte", "pt": "Transporte"}'),
    ('vehicle',        'Vehicle',                'expense',  '🚙', '#AA96DA', 'need', '{"en": "Vehicle", "es": "Vehículo", "pt": "Veículo"}'),
    ('entertainment',  'Life & Entertainment',   'expense',  '🎬', '#FCBAD3', 'want', '{"en": "Life & Entertainment", "es": "Vida y Entretenimiento", "pt": "Vida e Entretenimento"}'),
    ('technology',     'Technology & Internet',   'expense',  '💻', '#FFFFD2', 'need', '{"en": "Technology & Internet", "es": "Tecnología e Internet", "pt": "Tecnologia e Internet"}'),
    ('financial',      'Financial Expenses',      'expense',  '💰', '#A8D8EA', 'must', '{"en": "Financial Expenses", "es": "Gastos Financieros", "pt": "Despesas Financeiras"}'),
    ('investments',    'Investments',             'expense',  '📊', '#845EC2', 'none', '{"en": "Investments", "es": "Inversiones", "pt": "Investimentos"}'),
    ('income',         'Income',                  'income',   '💵', '#51CF66', 'none', '{"en": "Income", "es": "Ingresos", "pt": "Renda"}'),
    ('others',         'Others',                  'expense',  '❓', '#95A5A6', 'none', '{"en": "Others", "es": "Otros", "pt": "Outros"}'),
    ('transfer',       'Transfer',                'transfer', '↔️', '#6B7280', 'none', '{"en": "Transfer", "es": "Transferencia", "pt": "Transferência"}');

  -- ---- CHILDREN ----
  INSERT INTO _seed_categories (slug, name, type, icon, color, spending_nature, translations, parent_slug) VALUES
    -- Food & Drinks
    ('bar-cafe',       'Bar, Cafe',              'expense', '☕', '#FF6B6B', 'need', '{"en": "Bar, Cafe", "es": "Bar, Café", "pt": "Bar, Café"}', 'food-drinks'),
    ('restaurant',     'Restaurant, Fast-food',  'expense', '🍽️', '#FF6B6B', 'need', '{"en": "Restaurant, Fast-food", "es": "Restaurante, Comida rápida", "pt": "Restaurante, Fast-food"}', 'food-drinks'),
    ('groceries',      'Groceries',              'expense', '🛒', '#FF6B6B', 'need', '{"en": "Groceries", "es": "Supermercado", "pt": "Supermercado"}', 'food-drinks'),
    ('delivery',       'Delivery',               'expense', '🛵', '#FF9F43', 'want', '{"en": "Delivery", "es": "Domicilios", "pt": "Delivery"}', 'food-drinks'),
    -- Shopping
    ('drugstore',      'Drug-store, Chemist',    'expense', '💊', '#4ECDC4', 'need', '{"en": "Drug-store, Chemist", "es": "Farmacia, Droguería", "pt": "Farmácia, Drogaria"}', 'shopping'),
    ('gaming-hobbies', 'Gaming & Hobbies',       'expense', '🎮', '#4ECDC4', 'want', '{"en": "Gaming & Hobbies", "es": "Videojuegos y Pasatiempos", "pt": "Jogos e Hobbies"}', 'shopping'),
    ('stationery',     'Stationery, Tools',      'expense', '✏️', '#4ECDC4', 'want', '{"en": "Stationery, Tools", "es": "Papelería, Herramientas", "pt": "Papelaria, Ferramentas"}', 'shopping'),
    ('gifts',          'Gifts, Joy',             'expense', '🎁', '#4ECDC4', 'want', '{"en": "Gifts, Joy", "es": "Regalos, Alegría", "pt": "Presentes, Alegria"}', 'shopping'),
    ('electronics',    'Electronics, Accessories','expense', '📱', '#4ECDC4', 'want', '{"en": "Electronics, Accessories", "es": "Electrónica, Accesorios", "pt": "Eletrônica, Acessórios"}', 'shopping'),
    ('pets',           'Pets, Animals',          'expense', '🐕', '#4ECDC4', 'need', '{"en": "Pets, Animals", "es": "Mascotas, Animales", "pt": "Animais de Estimação"}', 'shopping'),
    ('home-garden',    'Home, Garden',           'expense', '🏡', '#4ECDC4', 'want', '{"en": "Home, Garden", "es": "Hogar, Jardín", "pt": "Casa, Jardim"}', 'shopping'),
    ('kids',           'Kids',                   'expense', '👶', '#4ECDC4', 'need', '{"en": "Kids", "es": "Niños", "pt": "Crianças"}', 'shopping'),
    ('health-beauty',  'Health and Beauty',      'expense', '💄', '#4ECDC4', 'want', '{"en": "Health and Beauty", "es": "Salud y Belleza", "pt": "Saúde e Beleza"}', 'shopping'),
    ('jewels',         'Jewels, Accessories',    'expense', '💎', '#4ECDC4', 'want', '{"en": "Jewels, Accessories", "es": "Joyas, Accesorios", "pt": "Jóias, Acessórios"}', 'shopping'),
    ('clothes',        'Clothes & Footwear',     'expense', '👕', '#4ECDC4', 'want', '{"en": "Clothes & Footwear", "es": "Ropa y Calzado", "pt": "Roupas e Calçados"}', 'shopping'),
    -- Housing
    ('property-insurance','Property Insurance',   'expense', '🛡️', '#95E1D3', 'must', '{"en": "Property Insurance", "es": "Seguro de Propiedad", "pt": "Seguro de Propriedade"}', 'housing'),
    ('maintenance',    'Maintenance, Repairs',   'expense', '🔧', '#95E1D3', 'must', '{"en": "Maintenance, Repairs", "es": "Mantenimiento, Reparaciones", "pt": "Manutenção, Reparos"}', 'housing'),
    ('housing-services','Services',              'expense', '🔌', '#95E1D3', 'must', '{"en": "Services", "es": "Servicios", "pt": "Serviços"}', 'housing'),
    ('utilities',      'Energy, Utilities',      'expense', '💡', '#95E1D3', 'must', '{"en": "Energy, Utilities", "es": "Energía, Servicios públicos", "pt": "Energia, Serviços públicos"}', 'housing'),
    ('mortgage',       'Mortgage',               'expense', '🏦', '#95E1D3', 'must', '{"en": "Mortgage", "es": "Hipoteca", "pt": "Hipoteca"}', 'housing'),
    ('rent',           'Rent',                   'expense', '🔑', '#95E1D3', 'must', '{"en": "Rent", "es": "Arriendo", "pt": "Aluguel"}', 'housing'),
    -- Transportation
    ('business-trips', 'Business Trips',         'expense', '✈️', '#F38181', 'need', '{"en": "Business Trips", "es": "Viajes de Negocios", "pt": "Viagens de Negócios"}', 'transportation'),
    ('long-distance',  'Long Distance',          'expense', '🚄', '#F38181', 'need', '{"en": "Long Distance", "es": "Larga Distancia", "pt": "Longa Distância"}', 'transportation'),
    ('taxi',           'Taxi',                   'expense', '🚕', '#F38181', 'need', '{"en": "Taxi", "es": "Taxi", "pt": "Táxi"}', 'transportation'),
    ('public-transport','Public Transport',      'expense', '🚌', '#F38181', 'need', '{"en": "Public Transport", "es": "Transporte público", "pt": "Transporte público"}', 'transportation'),
    -- Vehicle
    ('leasing',        'Leasing',                'expense', '📋', '#AA96DA', 'must', '{"en": "Leasing", "es": "Leasing", "pt": "Leasing"}', 'vehicle'),
    ('vehicle-insurance','Vehicle Insurance',     'expense', '🛡️', '#AA96DA', 'must', '{"en": "Vehicle Insurance", "es": "Seguro de Vehículo", "pt": "Seguro de Veículo"}', 'vehicle'),
    ('vehicle-rentals','Rentals',                'expense', '🔑', '#AA96DA', 'want', '{"en": "Rentals", "es": "Alquiler", "pt": "Aluguel"}', 'vehicle'),
    ('vehicle-maintenance','Vehicle Maintenance','expense', '🔧', '#AA96DA', 'need', '{"en": "Vehicle Maintenance", "es": "Mantenimiento de Vehículo", "pt": "Manutenção de Veículo"}', 'vehicle'),
    ('parking',        'Parking',                'expense', '🅿️', '#AA96DA', 'need', '{"en": "Parking", "es": "Estacionamiento", "pt": "Estacionamento"}', 'vehicle'),
    ('fuel',           'Fuel',                   'expense', '⛽', '#AA96DA', 'need', '{"en": "Fuel", "es": "Combustible", "pt": "Combustível"}', 'vehicle'),
    -- Life & Entertainment
    ('lottery',        'Lottery, Gambling',       'expense', '🎰', '#FCBAD3', 'want', '{"en": "Lottery, Gambling", "es": "Lotería, Apuestas", "pt": "Loteria, Apostas"}', 'entertainment'),
    ('alcohol-tobacco','Alcohol, Tobacco',       'expense', '🍷', '#FCBAD3', 'want', '{"en": "Alcohol, Tobacco", "es": "Alcohol, Tabaco", "pt": "Álcool, Tabaco"}', 'entertainment'),
    ('holiday',        'Holiday, Trips, Hotels', 'expense', '🏖️', '#FCBAD3', 'want', '{"en": "Holiday, Trips, Hotels", "es": "Vacaciones, Viajes, Hoteles", "pt": "Férias, Viagens, Hotéis"}', 'entertainment'),
    ('subscriptions',  'Subscriptions & Streaming','expense','📺', '#FCBAD3', 'want', '{"en": "Subscriptions & Streaming", "es": "Suscripciones y Streaming", "pt": "Assinaturas e Streaming"}', 'entertainment'),
    ('education',      'Education, Development', 'expense', '📖', '#FCBAD3', 'need', '{"en": "Education, Development", "es": "Educación, Desarrollo", "pt": "Educação, Desenvolvimento"}', 'entertainment'),
    ('hobbies',        'Hobbies',                'expense', '🎨', '#FCBAD3', 'want', '{"en": "Hobbies", "es": "Pasatiempos", "pt": "Hobbies"}', 'entertainment'),
    ('life-events',    'Life Events',            'expense', '🎉', '#FCBAD3', 'want', '{"en": "Life Events", "es": "Eventos de Vida", "pt": "Eventos da Vida"}', 'entertainment'),
    ('culture-events', 'Culture, Sport Events',  'expense', '🎭', '#FCBAD3', 'want', '{"en": "Culture, Sport Events", "es": "Cultura, Eventos deportivos", "pt": "Cultura, Eventos esportivos"}', 'entertainment'),
    ('fitness',        'Active Sport, Fitness',  'expense', '💪', '#FCBAD3', 'need', '{"en": "Active Sport, Fitness", "es": "Deporte, Fitness", "pt": "Esporte, Fitness"}', 'entertainment'),
    ('wellness',       'Wellness, Beauty',       'expense', '💆', '#FCBAD3', 'want', '{"en": "Wellness, Beauty", "es": "Bienestar, Belleza", "pt": "Bem-estar, Beleza"}', 'entertainment'),
    ('health-care',    'Health Care, Doctor',    'expense', '⚕️', '#FCBAD3', 'must', '{"en": "Health Care, Doctor", "es": "Salud, Médico", "pt": "Saúde, Médico"}', 'entertainment'),
    ('personal-care',  'Personal Care',          'expense', '💇', '#FDA7DF', 'need', '{"en": "Personal Care", "es": "Cuidado personal", "pt": "Cuidados pessoais"}', 'entertainment'),
    -- Technology & Internet
    ('postal',         'Postal Services',        'expense', '📮', '#FFFFD2', 'need', '{"en": "Postal Services", "es": "Servicios postales", "pt": "Serviços postais"}', 'technology'),
    ('software',       'Software, Apps, Games',  'expense', '🎮', '#FFFFD2', 'want', '{"en": "Software, Apps, Games", "es": "Software, Apps, Juegos", "pt": "Software, Apps, Jogos"}', 'technology'),
    ('internet',       'Internet',               'expense', '🌐', '#FFFFD2', 'must', '{"en": "Internet", "es": "Internet", "pt": "Internet"}', 'technology'),
    ('phone',          'Telephony, Mobile Phone','expense', '📱', '#FFFFD2', 'must', '{"en": "Telephony, Mobile Phone", "es": "Telefonía, Celular", "pt": "Telefonia, Celular"}', 'technology'),
    ('cloud-services', 'Cloud Services',         'expense', '☁️', '#74B9FF', 'want', '{"en": "Cloud Services", "es": "Servicios en la nube", "pt": "Serviços em nuvem"}', 'technology'),
    -- Financial Expenses
    ('child-support-expense','Child Support',     'expense', '👶', '#A8D8EA', 'must', '{"en": "Child Support", "es": "Pensión alimenticia", "pt": "Pensão alimentícia"}', 'financial'),
    ('fees',           'Charges, Fees',          'expense', '💵', '#A8D8EA', 'must', '{"en": "Charges, Fees", "es": "Cargos, Comisiones", "pt": "Taxas, Tarifas"}', 'financial'),
    ('advisory',       'Advisory',               'expense', '📊', '#A8D8EA', 'want', '{"en": "Advisory", "es": "Asesoría", "pt": "Consultoria"}', 'financial'),
    ('fines',          'Fines',                  'expense', '🚫', '#A8D8EA', 'must', '{"en": "Fines", "es": "Multas", "pt": "Multas"}', 'financial'),
    ('loans',          'Loans, Interests',       'expense', '🏦', '#A8D8EA', 'must', '{"en": "Loans, Interests", "es": "Préstamos, Intereses", "pt": "Empréstimos, Juros"}', 'financial'),
    ('insurances',     'Insurances',             'expense', '🛡️', '#A8D8EA', 'must', '{"en": "Insurances", "es": "Seguros", "pt": "Seguros"}', 'financial'),
    ('taxes',          'Taxes',                  'expense', '📋', '#A8D8EA', 'must', '{"en": "Taxes", "es": "Impuestos", "pt": "Impostos"}', 'financial'),
    ('debt-payment',   'Debt Payment',           'expense', '💳', '#E17055', 'must', '{"en": "Debt Payment", "es": "Pago de deuda", "pt": "Pagamento de dívida"}', 'financial'),
    -- Investments
    ('art-collectibles','Art & Collectibles',    'expense', '🖼️', '#845EC2', 'none', '{"en": "Art & Collectibles", "es": "Arte y Coleccionables", "pt": "Arte e Colecionáveis"}', 'investments'),
    ('savings-category','Savings',               'expense', '🏦', '#845EC2', 'none', '{"en": "Savings", "es": "Ahorros", "pt": "Poupança"}', 'investments'),
    ('financial-investments','Financial Investments','expense','📈','#845EC2', 'none', '{"en": "Financial Investments", "es": "Inversiones financieras", "pt": "Investimentos financeiros"}', 'investments'),
    ('vehicle-investments','Vehicle Investments', 'expense', '🚗', '#845EC2', 'none', '{"en": "Vehicle Investments", "es": "Inversiones en Vehículos", "pt": "Investimentos em Veículos"}', 'investments'),
    ('realty',         'Realty',                  'expense', '🏢', '#845EC2', 'none', '{"en": "Realty", "es": "Bienes raíces", "pt": "Imóveis"}', 'investments'),
    -- Income
    ('gifts-income',   'Gifts (Income)',         'income',  '🎁', '#51CF66', 'none', '{"en": "Gifts (Income)", "es": "Regalos (Ingreso)", "pt": "Presentes (Renda)"}', 'income'),
    ('child-support-income','Child Support (Income)','income','👶','#51CF66', 'none', '{"en": "Child Support (Income)", "es": "Pensión alimenticia (Ingreso)", "pt": "Pensão alimentícia (Renda)"}', 'income'),
    ('refunds',        'Refunds',                'income',  '↩️', '#51CF66', 'none', '{"en": "Refunds", "es": "Reembolsos", "pt": "Reembolsos"}', 'income'),
    ('lottery-income', 'Lottery, Gambling (Income)','income','🎰','#51CF66', 'none', '{"en": "Lottery, Gambling (Income)", "es": "Lotería, Apuestas (Ingreso)", "pt": "Loteria, Apostas (Renda)"}', 'income'),
    ('checks',         'Checks, Coupons',        'income',  '🎫', '#51CF66', 'none', '{"en": "Checks, Coupons", "es": "Cheques, Cupones", "pt": "Cheques, Cupons"}', 'income'),
    ('lending',        'Lending, Renting',       'income',  '🤝', '#51CF66', 'none', '{"en": "Lending, Renting", "es": "Préstamos, Alquiler", "pt": "Empréstimos, Aluguel"}', 'income'),
    ('grants',         'Dues & Grants',          'income',  '🎓', '#51CF66', 'none', '{"en": "Dues & Grants", "es": "Cuotas y Becas", "pt": "Cotas e Bolsas"}', 'income'),
    ('rental-income',  'Rental Income',          'income',  '🏠', '#51CF66', 'none', '{"en": "Rental Income", "es": "Ingresos por Alquiler", "pt": "Renda de Aluguel"}', 'income'),
    ('sale',           'Sale',                   'income',  '💰', '#51CF66', 'none', '{"en": "Sale", "es": "Venta", "pt": "Venda"}', 'income'),
    ('dividends',      'Interests, Dividends',   'income',  '📈', '#51CF66', 'none', '{"en": "Interests, Dividends", "es": "Intereses, Dividendos", "pt": "Juros, Dividendos"}', 'income'),
    ('wage',           'Wage, Invoices',         'income',  '💼', '#51CF66', 'none', '{"en": "Wage, Invoices", "es": "Salario, Facturas", "pt": "Salário, Faturas"}', 'income'),
    -- Others
    ('uncategorized',  'Uncategorized',          'expense', '❌', '#95A5A6', 'none', '{"en": "Uncategorized", "es": "Sin categoría", "pt": "Sem categoria"}', 'others'),
    ('charity',        'Charity, Gifts',         'expense', '❤️', '#95A5A6', 'want', '{"en": "Charity, Gifts", "es": "Caridad, Donaciones", "pt": "Caridade, Doações"}', 'others');

  -- =========================================
  -- PASS 1: Upsert parent categories (parent_slug IS NULL)
  -- =========================================
  FOR rec IN SELECT * FROM _seed_categories WHERE parent_slug IS NULL ORDER BY slug
  LOOP
    IF EXISTS (SELECT 1 FROM categories WHERE slug = rec.slug AND user_id = v_user_id) THEN
      -- Update metadata only (preserve user's custom name)
      UPDATE categories SET
        is_default = true,
        spending_nature = rec.spending_nature::spending_nature,
        icon = rec.icon,
        color = rec.color,
        translations = rec.translations,
        type = rec.type
      WHERE slug = rec.slug AND user_id = v_user_id;
      RAISE NOTICE 'UPDATED parent: %', rec.slug;
    ELSE
      INSERT INTO categories (user_id, name, slug, type, icon, color, is_default, spending_nature, translations)
      VALUES (v_user_id, rec.name, rec.slug, rec.type, rec.icon, rec.color, true, rec.spending_nature::spending_nature, rec.translations);
      RAISE NOTICE 'INSERTED parent: %', rec.slug;
    END IF;
  END LOOP;

  -- =========================================
  -- PASS 2: Upsert child categories (parent_slug IS NOT NULL)
  -- =========================================
  FOR rec IN SELECT * FROM _seed_categories WHERE parent_slug IS NOT NULL ORDER BY parent_slug, slug
  LOOP
    -- Resolve parent_id from user's actual categories
    SELECT id INTO v_parent_id FROM categories WHERE slug = rec.parent_slug AND user_id = v_user_id;

    IF v_parent_id IS NULL THEN
      RAISE WARNING 'Parent slug "%" not found for child "%" — skipping', rec.parent_slug, rec.slug;
      CONTINUE;
    END IF;

    IF EXISTS (SELECT 1 FROM categories WHERE slug = rec.slug AND user_id = v_user_id) THEN
      -- Update metadata only (preserve user's custom name)
      UPDATE categories SET
        is_default = true,
        spending_nature = rec.spending_nature::spending_nature,
        icon = rec.icon,
        color = rec.color,
        translations = rec.translations,
        type = rec.type,
        parent_id = v_parent_id
      WHERE slug = rec.slug AND user_id = v_user_id;
      RAISE NOTICE 'UPDATED child: % (parent: %)', rec.slug, rec.parent_slug;
    ELSE
      INSERT INTO categories (user_id, name, slug, type, icon, color, parent_id, is_default, spending_nature, translations)
      VALUES (v_user_id, rec.name, rec.slug, rec.type, rec.icon, rec.color, v_parent_id, true, rec.spending_nature::spending_nature, rec.translations);
      RAISE NOTICE 'INSERTED child: % (parent: %)', rec.slug, rec.parent_slug;
    END IF;
  END LOOP;

  RAISE NOTICE '✅ Backfill complete for user %', v_user_id;
END;
$$;
