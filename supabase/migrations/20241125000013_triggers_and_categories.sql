-- ====================================
-- TRIGGERS + CATEGORY OVERHAUL
-- D1: Cash account trigger
-- D2: Default categories trigger
-- D3: Category renaming and restructuring
-- ====================================

-- 1. Add translations column to categories
ALTER TABLE categories ADD COLUMN IF NOT EXISTS translations JSONB DEFAULT '{}';

-- ====================================
-- D1: CASH ACCOUNT TRIGGER
-- ====================================

CREATE OR REPLACE FUNCTION public.handle_new_user_default_account()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.accounts (user_id, name, type, institution, currency, color, icon, is_active)
  VALUES (NEW.id, 'Cash', 'cash', 'cash', 'COP', '#10B981', '💵', true);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created_account
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_default_account();

-- ====================================
-- D2 + D3: DEFAULT CATEGORIES TRIGGER
-- Includes all renames, moves, merges, and new categories
-- ====================================

CREATE OR REPLACE FUNCTION public.handle_new_user_default_categories()
RETURNS TRIGGER AS $$
DECLARE
  -- Parent category UUIDs
  v_food_drinks UUID;
  v_shopping UUID;
  v_housing UUID;
  v_transportation UUID;
  v_vehicle UUID;
  v_entertainment UUID;
  v_technology UUID;
  v_financial UUID;
  v_investments UUID;
  v_income UUID;
  v_others UUID;
  v_transfer UUID;
BEGIN
  -- =========================================
  -- PASS 1: Insert all parent categories
  -- =========================================

  -- Food & Drinks
  v_food_drinks := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, translations)
  VALUES (v_food_drinks, NEW.id, 'Food & Drinks', 'food-drinks', 'expense', '🍔', '#FF6B6B',
    '{"en": "Food & Drinks", "es": "Comida y Bebidas", "pt": "Comida e Bebidas"}'::jsonb);

  -- Shopping
  v_shopping := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, translations)
  VALUES (v_shopping, NEW.id, 'Shopping', 'shopping', 'expense', '🛍️', '#4ECDC4',
    '{"en": "Shopping", "es": "Compras", "pt": "Compras"}'::jsonb);

  -- Housing
  v_housing := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, translations)
  VALUES (v_housing, NEW.id, 'Housing', 'housing', 'expense', '🏠', '#95E1D3',
    '{"en": "Housing", "es": "Vivienda", "pt": "Moradia"}'::jsonb);

  -- Transportation
  v_transportation := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, translations)
  VALUES (v_transportation, NEW.id, 'Transportation', 'transportation', 'expense', '🚗', '#F38181',
    '{"en": "Transportation", "es": "Transporte", "pt": "Transporte"}'::jsonb);

  -- Vehicle
  v_vehicle := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, translations)
  VALUES (v_vehicle, NEW.id, 'Vehicle', 'vehicle', 'expense', '🚙', '#AA96DA',
    '{"en": "Vehicle", "es": "Vehiculo", "pt": "Veiculo"}'::jsonb);

  -- Life & Entertainment
  v_entertainment := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, translations)
  VALUES (v_entertainment, NEW.id, 'Life & Entertainment', 'entertainment', 'expense', '🎬', '#FCBAD3',
    '{"en": "Life & Entertainment", "es": "Vida y Entretenimiento", "pt": "Vida e Entretenimento"}'::jsonb);

  -- Technology & Internet (renamed from "Communication, PC")
  v_technology := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, translations)
  VALUES (v_technology, NEW.id, 'Technology & Internet', 'technology', 'expense', '💻', '#FFFFD2',
    '{"en": "Technology & Internet", "es": "Tecnologia e Internet", "pt": "Tecnologia e Internet"}'::jsonb);

  -- Financial Expenses
  v_financial := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, translations)
  VALUES (v_financial, NEW.id, 'Financial Expenses', 'financial', 'expense', '💰', '#A8D8EA',
    '{"en": "Financial Expenses", "es": "Gastos Financieros", "pt": "Despesas Financeiras"}'::jsonb);

  -- Investments
  v_investments := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, translations)
  VALUES (v_investments, NEW.id, 'Investments', 'investments', 'expense', '📊', '#845EC2',
    '{"en": "Investments", "es": "Inversiones", "pt": "Investimentos"}'::jsonb);

  -- Income
  v_income := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, translations)
  VALUES (v_income, NEW.id, 'Income', 'income', 'income', '💵', '#51CF66',
    '{"en": "Income", "es": "Ingresos", "pt": "Renda"}'::jsonb);

  -- Others
  v_others := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, translations)
  VALUES (v_others, NEW.id, 'Others', 'others', 'expense', '❓', '#95A5A6',
    '{"en": "Others", "es": "Otros", "pt": "Outros"}'::jsonb);

  -- Transfer
  v_transfer := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, translations)
  VALUES (v_transfer, NEW.id, 'Transfer', 'transfer', 'transfer', '↔️', '#6B7280',
    '{"en": "Transfer", "es": "Transferencia", "pt": "Transferencia"}'::jsonb);

  -- =========================================
  -- PASS 2: Insert all child categories
  -- =========================================

  -- ---- Food & Drinks children ----
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, translations)
  VALUES
    (NEW.id, 'Bar, Cafe', 'bar-cafe', 'expense', '☕', '#FF6B6B', v_food_drinks,
      '{"en": "Bar, Cafe", "es": "Bar, Cafe", "pt": "Bar, Cafe"}'::jsonb),
    (NEW.id, 'Restaurant, Fast-food', 'restaurant', 'expense', '🍽️', '#FF6B6B', v_food_drinks,
      '{"en": "Restaurant, Fast-food", "es": "Restaurante, Comida rapida", "pt": "Restaurante, Fast-food"}'::jsonb),
    (NEW.id, 'Groceries', 'groceries', 'expense', '🛒', '#FF6B6B', v_food_drinks,
      '{"en": "Groceries", "es": "Supermercado", "pt": "Supermercado"}'::jsonb),
    -- NEW: Delivery
    (NEW.id, 'Delivery', 'delivery', 'expense', '🛵', '#FF9F43', v_food_drinks,
      '{"en": "Delivery", "es": "Domicilios", "pt": "Delivery"}'::jsonb);

  -- ---- Shopping children ----
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, translations)
  VALUES
    (NEW.id, 'Drug-store, Chemist', 'drugstore', 'expense', '💊', '#4ECDC4', v_shopping,
      '{"en": "Drug-store, Chemist", "es": "Farmacia, Drogueria", "pt": "Farmacia, Drogaria"}'::jsonb),
    -- RENAMED: leisure -> Gaming & Hobbies
    (NEW.id, 'Gaming & Hobbies', 'gaming-hobbies', 'expense', '🎮', '#4ECDC4', v_shopping,
      '{"en": "Gaming & Hobbies", "es": "Videojuegos y Pasatiempos", "pt": "Jogos e Hobbies"}'::jsonb),
    (NEW.id, 'Stationery, Tools', 'stationery', 'expense', '✏️', '#4ECDC4', v_shopping,
      '{"en": "Stationery, Tools", "es": "Papeleria, Herramientas", "pt": "Papelaria, Ferramentas"}'::jsonb),
    (NEW.id, 'Gifts, Joy', 'gifts', 'expense', '🎁', '#4ECDC4', v_shopping,
      '{"en": "Gifts, Joy", "es": "Regalos, Alegria", "pt": "Presentes, Alegria"}'::jsonb),
    (NEW.id, 'Electronics, Accessories', 'electronics', 'expense', '📱', '#4ECDC4', v_shopping,
      '{"en": "Electronics, Accessories", "es": "Electronica, Accesorios", "pt": "Eletronica, Acessorios"}'::jsonb),
    (NEW.id, 'Pets, Animals', 'pets', 'expense', '🐕', '#4ECDC4', v_shopping,
      '{"en": "Pets, Animals", "es": "Mascotas, Animales", "pt": "Animais de Estimacao"}'::jsonb),
    (NEW.id, 'Home, Garden', 'home-garden', 'expense', '🏡', '#4ECDC4', v_shopping,
      '{"en": "Home, Garden", "es": "Hogar, Jardin", "pt": "Casa, Jardim"}'::jsonb),
    (NEW.id, 'Kids', 'kids', 'expense', '👶', '#4ECDC4', v_shopping,
      '{"en": "Kids", "es": "Ninos", "pt": "Criancas"}'::jsonb),
    (NEW.id, 'Health and Beauty', 'health-beauty', 'expense', '💄', '#4ECDC4', v_shopping,
      '{"en": "Health and Beauty", "es": "Salud y Belleza", "pt": "Saude e Beleza"}'::jsonb),
    (NEW.id, 'Jewels, Accessories', 'jewels', 'expense', '💎', '#4ECDC4', v_shopping,
      '{"en": "Jewels, Accessories", "es": "Joyas, Accesorios", "pt": "Joias, Acessorios"}'::jsonb),
    (NEW.id, 'Clothes & Footwear', 'clothes', 'expense', '👕', '#4ECDC4', v_shopping,
      '{"en": "Clothes & Footwear", "es": "Ropa y Calzado", "pt": "Roupas e Calcados"}'::jsonb);

  -- ---- Housing children ----
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, translations)
  VALUES
    (NEW.id, 'Property Insurance', 'property-insurance', 'expense', '🛡️', '#95E1D3', v_housing,
      '{"en": "Property Insurance", "es": "Seguro de Propiedad", "pt": "Seguro de Propriedade"}'::jsonb),
    (NEW.id, 'Maintenance, Repairs', 'maintenance', 'expense', '🔧', '#95E1D3', v_housing,
      '{"en": "Maintenance, Repairs", "es": "Mantenimiento, Reparaciones", "pt": "Manutencao, Reparos"}'::jsonb),
    (NEW.id, 'Services', 'housing-services', 'expense', '🔌', '#95E1D3', v_housing,
      '{"en": "Services", "es": "Servicios", "pt": "Servicos"}'::jsonb),
    (NEW.id, 'Energy, Utilities', 'utilities', 'expense', '💡', '#95E1D3', v_housing,
      '{"en": "Energy, Utilities", "es": "Energia, Servicios publicos", "pt": "Energia, Servicos publicos"}'::jsonb),
    (NEW.id, 'Mortgage', 'mortgage', 'expense', '🏦', '#95E1D3', v_housing,
      '{"en": "Mortgage", "es": "Hipoteca", "pt": "Hipoteca"}'::jsonb),
    (NEW.id, 'Rent', 'rent', 'expense', '🔑', '#95E1D3', v_housing,
      '{"en": "Rent", "es": "Arriendo", "pt": "Aluguel"}'::jsonb);

  -- ---- Transportation children ----
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, translations)
  VALUES
    (NEW.id, 'Business Trips', 'business-trips', 'expense', '✈️', '#F38181', v_transportation,
      '{"en": "Business Trips", "es": "Viajes de Negocios", "pt": "Viagens de Negocios"}'::jsonb),
    (NEW.id, 'Long Distance', 'long-distance', 'expense', '🚄', '#F38181', v_transportation,
      '{"en": "Long Distance", "es": "Larga Distancia", "pt": "Longa Distancia"}'::jsonb),
    (NEW.id, 'Taxi', 'taxi', 'expense', '🚕', '#F38181', v_transportation,
      '{"en": "Taxi", "es": "Taxi", "pt": "Taxi"}'::jsonb),
    (NEW.id, 'Public Transport', 'public-transport', 'expense', '🚌', '#F38181', v_transportation,
      '{"en": "Public Transport", "es": "Transporte publico", "pt": "Transporte publico"}'::jsonb);

  -- ---- Vehicle children ----
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, translations)
  VALUES
    (NEW.id, 'Leasing', 'leasing', 'expense', '📋', '#AA96DA', v_vehicle,
      '{"en": "Leasing", "es": "Leasing", "pt": "Leasing"}'::jsonb),
    (NEW.id, 'Vehicle Insurance', 'vehicle-insurance', 'expense', '🛡️', '#AA96DA', v_vehicle,
      '{"en": "Vehicle Insurance", "es": "Seguro de Vehiculo", "pt": "Seguro de Veiculo"}'::jsonb),
    (NEW.id, 'Rentals', 'vehicle-rentals', 'expense', '🔑', '#AA96DA', v_vehicle,
      '{"en": "Rentals", "es": "Alquiler", "pt": "Aluguel"}'::jsonb),
    (NEW.id, 'Vehicle Maintenance', 'vehicle-maintenance', 'expense', '🔧', '#AA96DA', v_vehicle,
      '{"en": "Vehicle Maintenance", "es": "Mantenimiento de Vehiculo", "pt": "Manutencao de Veiculo"}'::jsonb),
    (NEW.id, 'Parking', 'parking', 'expense', '🅿️', '#AA96DA', v_vehicle,
      '{"en": "Parking", "es": "Estacionamiento", "pt": "Estacionamento"}'::jsonb),
    (NEW.id, 'Fuel', 'fuel', 'expense', '⛽', '#AA96DA', v_vehicle,
      '{"en": "Fuel", "es": "Combustible", "pt": "Combustivel"}'::jsonb);

  -- ---- Life & Entertainment children ----
  -- NOTE: charity MOVED to Others, streaming+subscriptions MERGED into "Subscriptions & Streaming"
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, translations)
  VALUES
    (NEW.id, 'Lottery, Gambling', 'lottery', 'expense', '🎰', '#FCBAD3', v_entertainment,
      '{"en": "Lottery, Gambling", "es": "Loteria, Apuestas", "pt": "Loteria, Apostas"}'::jsonb),
    (NEW.id, 'Alcohol, Tobacco', 'alcohol-tobacco', 'expense', '🍷', '#FCBAD3', v_entertainment,
      '{"en": "Alcohol, Tobacco", "es": "Alcohol, Tabaco", "pt": "Alcool, Tabaco"}'::jsonb),
    (NEW.id, 'Holiday, Trips, Hotels', 'holiday', 'expense', '🏖️', '#FCBAD3', v_entertainment,
      '{"en": "Holiday, Trips, Hotels", "es": "Vacaciones, Viajes, Hoteles", "pt": "Ferias, Viagens, Hoteis"}'::jsonb),
    -- MERGED: streaming + subscriptions -> Subscriptions & Streaming
    (NEW.id, 'Subscriptions & Streaming', 'subscriptions', 'expense', '📺', '#FCBAD3', v_entertainment,
      '{"en": "Subscriptions & Streaming", "es": "Suscripciones y Streaming", "pt": "Assinaturas e Streaming"}'::jsonb),
    (NEW.id, 'Education, Development', 'education', 'expense', '📖', '#FCBAD3', v_entertainment,
      '{"en": "Education, Development", "es": "Educacion, Desarrollo", "pt": "Educacao, Desenvolvimento"}'::jsonb),
    (NEW.id, 'Hobbies', 'hobbies', 'expense', '🎨', '#FCBAD3', v_entertainment,
      '{"en": "Hobbies", "es": "Pasatiempos", "pt": "Hobbies"}'::jsonb),
    (NEW.id, 'Life Events', 'life-events', 'expense', '🎉', '#FCBAD3', v_entertainment,
      '{"en": "Life Events", "es": "Eventos de Vida", "pt": "Eventos da Vida"}'::jsonb),
    (NEW.id, 'Culture, Sport Events', 'culture-events', 'expense', '🎭', '#FCBAD3', v_entertainment,
      '{"en": "Culture, Sport Events", "es": "Cultura, Eventos deportivos", "pt": "Cultura, Eventos esportivos"}'::jsonb),
    (NEW.id, 'Active Sport, Fitness', 'fitness', 'expense', '💪', '#FCBAD3', v_entertainment,
      '{"en": "Active Sport, Fitness", "es": "Deporte, Fitness", "pt": "Esporte, Fitness"}'::jsonb),
    (NEW.id, 'Wellness, Beauty', 'wellness', 'expense', '💆', '#FCBAD3', v_entertainment,
      '{"en": "Wellness, Beauty", "es": "Bienestar, Belleza", "pt": "Bem-estar, Beleza"}'::jsonb),
    (NEW.id, 'Health Care, Doctor', 'health-care', 'expense', '⚕️', '#FCBAD3', v_entertainment,
      '{"en": "Health Care, Doctor", "es": "Salud, Medico", "pt": "Saude, Medico"}'::jsonb),
    -- NEW: Personal Care
    (NEW.id, 'Personal Care', 'personal-care', 'expense', '💇', '#FDA7DF', v_entertainment,
      '{"en": "Personal Care", "es": "Cuidado personal", "pt": "Cuidados pessoais"}'::jsonb);

  -- ---- Technology & Internet children (renamed from Communication, PC) ----
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, translations)
  VALUES
    (NEW.id, 'Postal Services', 'postal', 'expense', '📮', '#FFFFD2', v_technology,
      '{"en": "Postal Services", "es": "Servicios postales", "pt": "Servicos postais"}'::jsonb),
    (NEW.id, 'Software, Apps, Games', 'software', 'expense', '🎮', '#FFFFD2', v_technology,
      '{"en": "Software, Apps, Games", "es": "Software, Apps, Juegos", "pt": "Software, Apps, Jogos"}'::jsonb),
    (NEW.id, 'Internet', 'internet', 'expense', '🌐', '#FFFFD2', v_technology,
      '{"en": "Internet", "es": "Internet", "pt": "Internet"}'::jsonb),
    (NEW.id, 'Telephony, Mobile Phone', 'phone', 'expense', '📱', '#FFFFD2', v_technology,
      '{"en": "Telephony, Mobile Phone", "es": "Telefonia, Celular", "pt": "Telefonia, Celular"}'::jsonb),
    -- NEW: Cloud Services
    (NEW.id, 'Cloud Services', 'cloud-services', 'expense', '☁️', '#74B9FF', v_technology,
      '{"en": "Cloud Services", "es": "Servicios en la nube", "pt": "Servicos em nuvem"}'::jsonb);

  -- ---- Financial Expenses children ----
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, translations)
  VALUES
    (NEW.id, 'Child Support', 'child-support-expense', 'expense', '👶', '#A8D8EA', v_financial,
      '{"en": "Child Support", "es": "Pension alimenticia", "pt": "Pensao alimenticia"}'::jsonb),
    (NEW.id, 'Charges, Fees', 'fees', 'expense', '💵', '#A8D8EA', v_financial,
      '{"en": "Charges, Fees", "es": "Cargos, Comisiones", "pt": "Taxas, Tarifas"}'::jsonb),
    (NEW.id, 'Advisory', 'advisory', 'expense', '📊', '#A8D8EA', v_financial,
      '{"en": "Advisory", "es": "Asesoria", "pt": "Consultoria"}'::jsonb),
    (NEW.id, 'Fines', 'fines', 'expense', '🚫', '#A8D8EA', v_financial,
      '{"en": "Fines", "es": "Multas", "pt": "Multas"}'::jsonb),
    (NEW.id, 'Loans, Interests', 'loans', 'expense', '🏦', '#A8D8EA', v_financial,
      '{"en": "Loans, Interests", "es": "Prestamos, Intereses", "pt": "Emprestimos, Juros"}'::jsonb),
    (NEW.id, 'Insurances', 'insurances', 'expense', '🛡️', '#A8D8EA', v_financial,
      '{"en": "Insurances", "es": "Seguros", "pt": "Seguros"}'::jsonb),
    (NEW.id, 'Taxes', 'taxes', 'expense', '📋', '#A8D8EA', v_financial,
      '{"en": "Taxes", "es": "Impuestos", "pt": "Impostos"}'::jsonb),
    -- NEW: Debt Payment
    (NEW.id, 'Debt Payment', 'debt-payment', 'expense', '💳', '#E17055', v_financial,
      '{"en": "Debt Payment", "es": "Pago de deuda", "pt": "Pagamento de divida"}'::jsonb);

  -- ---- Investments children ----
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, translations)
  VALUES
    -- RENAMED: collections -> Art & Collectibles
    (NEW.id, 'Art & Collectibles', 'art-collectibles', 'expense', '🖼️', '#845EC2', v_investments,
      '{"en": "Art & Collectibles", "es": "Arte y Coleccionables", "pt": "Arte e Colecionaveis"}'::jsonb),
    (NEW.id, 'Savings', 'savings-category', 'expense', '🏦', '#845EC2', v_investments,
      '{"en": "Savings", "es": "Ahorros", "pt": "Poupanca"}'::jsonb),
    (NEW.id, 'Financial Investments', 'financial-investments', 'expense', '📈', '#845EC2', v_investments,
      '{"en": "Financial Investments", "es": "Inversiones financieras", "pt": "Investimentos financeiros"}'::jsonb),
    -- RENAMED: vehicles-chattels -> Vehicle Investments
    (NEW.id, 'Vehicle Investments', 'vehicle-investments', 'expense', '🚗', '#845EC2', v_investments,
      '{"en": "Vehicle Investments", "es": "Inversiones en Vehiculos", "pt": "Investimentos em Veiculos"}'::jsonb),
    (NEW.id, 'Realty', 'realty', 'expense', '🏢', '#845EC2', v_investments,
      '{"en": "Realty", "es": "Bienes raices", "pt": "Imoveis"}'::jsonb);

  -- ---- Income children ----
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, translations)
  VALUES
    (NEW.id, 'Gifts (Income)', 'gifts-income', 'income', '🎁', '#51CF66', v_income,
      '{"en": "Gifts (Income)", "es": "Regalos (Ingreso)", "pt": "Presentes (Renda)"}'::jsonb),
    (NEW.id, 'Child Support (Income)', 'child-support-income', 'income', '👶', '#51CF66', v_income,
      '{"en": "Child Support (Income)", "es": "Pension alimenticia (Ingreso)", "pt": "Pensao alimenticia (Renda)"}'::jsonb),
    (NEW.id, 'Refunds', 'refunds', 'income', '↩️', '#51CF66', v_income,
      '{"en": "Refunds", "es": "Reembolsos", "pt": "Reembolsos"}'::jsonb),
    (NEW.id, 'Lottery, Gambling (Income)', 'lottery-income', 'income', '🎰', '#51CF66', v_income,
      '{"en": "Lottery, Gambling (Income)", "es": "Loteria, Apuestas (Ingreso)", "pt": "Loteria, Apostas (Renda)"}'::jsonb),
    (NEW.id, 'Checks, Coupons', 'checks', 'income', '🎫', '#51CF66', v_income,
      '{"en": "Checks, Coupons", "es": "Cheques, Cupones", "pt": "Cheques, Cupons"}'::jsonb),
    (NEW.id, 'Lending, Renting', 'lending', 'income', '🤝', '#51CF66', v_income,
      '{"en": "Lending, Renting", "es": "Prestamos, Alquiler", "pt": "Emprestimos, Aluguel"}'::jsonb),
    (NEW.id, 'Dues & Grants', 'grants', 'income', '🎓', '#51CF66', v_income,
      '{"en": "Dues & Grants", "es": "Cuotas y Becas", "pt": "Cotas e Bolsas"}'::jsonb),
    (NEW.id, 'Rental Income', 'rental-income', 'income', '🏠', '#51CF66', v_income,
      '{"en": "Rental Income", "es": "Ingresos por Alquiler", "pt": "Renda de Aluguel"}'::jsonb),
    (NEW.id, 'Sale', 'sale', 'income', '💰', '#51CF66', v_income,
      '{"en": "Sale", "es": "Venta", "pt": "Venda"}'::jsonb),
    (NEW.id, 'Interests, Dividends', 'dividends', 'income', '📈', '#51CF66', v_income,
      '{"en": "Interests, Dividends", "es": "Intereses, Dividendos", "pt": "Juros, Dividendos"}'::jsonb),
    (NEW.id, 'Wage, Invoices', 'wage', 'income', '💼', '#51CF66', v_income,
      '{"en": "Wage, Invoices", "es": "Salario, Facturas", "pt": "Salario, Faturas"}'::jsonb);

  -- ---- Others children ----
  -- RENAMED: missing -> Uncategorized; MOVED: charity from Entertainment to Others
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, translations)
  VALUES
    (NEW.id, 'Uncategorized', 'uncategorized', 'expense', '❌', '#95A5A6', v_others,
      '{"en": "Uncategorized", "es": "Sin categoria", "pt": "Sem categoria"}'::jsonb),
    -- MOVED: charity from Entertainment to Others
    (NEW.id, 'Charity, Gifts', 'charity', 'expense', '❤️', '#95A5A6', v_others,
      '{"en": "Charity, Gifts", "es": "Caridad, Donaciones", "pt": "Caridade, Doacoes"}'::jsonb);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created_categories
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_default_categories();
