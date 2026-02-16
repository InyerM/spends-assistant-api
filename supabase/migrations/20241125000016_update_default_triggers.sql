-- ====================================
-- MIGRATION 16: UPDATE DEFAULT TRIGGERS
-- Set is_default and spending_nature on auto-created accounts/categories
-- ====================================

-- 1. Update cash account trigger to set is_default = true
CREATE OR REPLACE FUNCTION public.handle_new_user_default_account()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.accounts (user_id, name, type, institution, currency, color, icon, is_active, is_default)
  VALUES (NEW.id, 'Cash', 'cash', 'cash', 'COP', '#10B981', '💵', true, true);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Update default categories trigger to set is_default = true and spending_nature
CREATE OR REPLACE FUNCTION public.handle_new_user_default_categories()
RETURNS TRIGGER AS $$
DECLARE
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

  -- Food & Drinks (spending_nature: need)
  v_food_drinks := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, is_default, spending_nature, translations)
  VALUES (v_food_drinks, NEW.id, 'Food & Drinks', 'food-drinks', 'expense', '🍔', '#FF6B6B', true, 'need',
    '{"en": "Food & Drinks", "es": "Comida y Bebidas", "pt": "Comida e Bebidas"}'::jsonb);

  -- Shopping (spending_nature: want)
  v_shopping := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, is_default, spending_nature, translations)
  VALUES (v_shopping, NEW.id, 'Shopping', 'shopping', 'expense', '🛍️', '#4ECDC4', true, 'want',
    '{"en": "Shopping", "es": "Compras", "pt": "Compras"}'::jsonb);

  -- Housing (spending_nature: must)
  v_housing := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, is_default, spending_nature, translations)
  VALUES (v_housing, NEW.id, 'Housing', 'housing', 'expense', '🏠', '#95E1D3', true, 'must',
    '{"en": "Housing", "es": "Vivienda", "pt": "Moradia"}'::jsonb);

  -- Transportation (spending_nature: need)
  v_transportation := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, is_default, spending_nature, translations)
  VALUES (v_transportation, NEW.id, 'Transportation', 'transportation', 'expense', '🚗', '#F38181', true, 'need',
    '{"en": "Transportation", "es": "Transporte", "pt": "Transporte"}'::jsonb);

  -- Vehicle (spending_nature: need)
  v_vehicle := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, is_default, spending_nature, translations)
  VALUES (v_vehicle, NEW.id, 'Vehicle', 'vehicle', 'expense', '🚙', '#AA96DA', true, 'need',
    '{"en": "Vehicle", "es": "Vehículo", "pt": "Veículo"}'::jsonb);

  -- Life & Entertainment (spending_nature: want)
  v_entertainment := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, is_default, spending_nature, translations)
  VALUES (v_entertainment, NEW.id, 'Life & Entertainment', 'entertainment', 'expense', '🎬', '#FCBAD3', true, 'want',
    '{"en": "Life & Entertainment", "es": "Vida y Entretenimiento", "pt": "Vida e Entretenimento"}'::jsonb);

  -- Technology & Internet (spending_nature: need)
  v_technology := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, is_default, spending_nature, translations)
  VALUES (v_technology, NEW.id, 'Technology & Internet', 'technology', 'expense', '💻', '#FFFFD2', true, 'need',
    '{"en": "Technology & Internet", "es": "Tecnología e Internet", "pt": "Tecnologia e Internet"}'::jsonb);

  -- Financial Expenses (spending_nature: must)
  v_financial := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, is_default, spending_nature, translations)
  VALUES (v_financial, NEW.id, 'Financial Expenses', 'financial', 'expense', '💰', '#A8D8EA', true, 'must',
    '{"en": "Financial Expenses", "es": "Gastos Financieros", "pt": "Despesas Financeiras"}'::jsonb);

  -- Investments (spending_nature: none)
  v_investments := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, is_default, spending_nature, translations)
  VALUES (v_investments, NEW.id, 'Investments', 'investments', 'expense', '📊', '#845EC2', true, 'none',
    '{"en": "Investments", "es": "Inversiones", "pt": "Investimentos"}'::jsonb);

  -- Income (spending_nature: none)
  v_income := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, is_default, spending_nature, translations)
  VALUES (v_income, NEW.id, 'Income', 'income', 'income', '💵', '#51CF66', true, 'none',
    '{"en": "Income", "es": "Ingresos", "pt": "Renda"}'::jsonb);

  -- Others (spending_nature: none)
  v_others := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, is_default, spending_nature, translations)
  VALUES (v_others, NEW.id, 'Others', 'others', 'expense', '❓', '#95A5A6', true, 'none',
    '{"en": "Others", "es": "Otros", "pt": "Outros"}'::jsonb);

  -- Transfer (spending_nature: none)
  v_transfer := gen_random_uuid();
  INSERT INTO public.categories (id, user_id, name, slug, type, icon, color, is_default, spending_nature, translations)
  VALUES (v_transfer, NEW.id, 'Transfer', 'transfer', 'transfer', '↔️', '#6B7280', true, 'none',
    '{"en": "Transfer", "es": "Transferencia", "pt": "Transferência"}'::jsonb);

  -- =========================================
  -- PASS 2: Insert all child categories (is_default = true, inherit parent spending_nature)
  -- =========================================

  -- ---- Food & Drinks children (need) ----
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, is_default, spending_nature, translations)
  VALUES
    (NEW.id, 'Bar, Cafe', 'bar-cafe', 'expense', '☕', '#FF6B6B', v_food_drinks, true, 'need',
      '{"en": "Bar, Cafe", "es": "Bar, Café", "pt": "Bar, Café"}'::jsonb),
    (NEW.id, 'Restaurant, Fast-food', 'restaurant', 'expense', '🍽️', '#FF6B6B', v_food_drinks, true, 'need',
      '{"en": "Restaurant, Fast-food", "es": "Restaurante, Comida rápida", "pt": "Restaurante, Fast-food"}'::jsonb),
    (NEW.id, 'Groceries', 'groceries', 'expense', '🛒', '#FF6B6B', v_food_drinks, true, 'need',
      '{"en": "Groceries", "es": "Supermercado", "pt": "Supermercado"}'::jsonb),
    (NEW.id, 'Delivery', 'delivery', 'expense', '🛵', '#FF9F43', v_food_drinks, true, 'want',
      '{"en": "Delivery", "es": "Domicilios", "pt": "Delivery"}'::jsonb);

  -- ---- Shopping children (want) ----
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, is_default, spending_nature, translations)
  VALUES
    (NEW.id, 'Drug-store, Chemist', 'drugstore', 'expense', '💊', '#4ECDC4', v_shopping, true, 'need',
      '{"en": "Drug-store, Chemist", "es": "Farmacia, Droguería", "pt": "Farmácia, Drogaria"}'::jsonb),
    (NEW.id, 'Gaming & Hobbies', 'gaming-hobbies', 'expense', '🎮', '#4ECDC4', v_shopping, true, 'want',
      '{"en": "Gaming & Hobbies", "es": "Videojuegos y Pasatiempos", "pt": "Jogos e Hobbies"}'::jsonb),
    (NEW.id, 'Stationery, Tools', 'stationery', 'expense', '✏️', '#4ECDC4', v_shopping, true, 'want',
      '{"en": "Stationery, Tools", "es": "Papelería, Herramientas", "pt": "Papelaria, Ferramentas"}'::jsonb),
    (NEW.id, 'Gifts, Joy', 'gifts', 'expense', '🎁', '#4ECDC4', v_shopping, true, 'want',
      '{"en": "Gifts, Joy", "es": "Regalos, Alegría", "pt": "Presentes, Alegria"}'::jsonb),
    (NEW.id, 'Electronics, Accessories', 'electronics', 'expense', '📱', '#4ECDC4', v_shopping, true, 'want',
      '{"en": "Electronics, Accessories", "es": "Electrónica, Accesorios", "pt": "Eletrônica, Acessórios"}'::jsonb),
    (NEW.id, 'Pets, Animals', 'pets', 'expense', '🐕', '#4ECDC4', v_shopping, true, 'need',
      '{"en": "Pets, Animals", "es": "Mascotas, Animales", "pt": "Animais de Estimação"}'::jsonb),
    (NEW.id, 'Home, Garden', 'home-garden', 'expense', '🏡', '#4ECDC4', v_shopping, true, 'want',
      '{"en": "Home, Garden", "es": "Hogar, Jardín", "pt": "Casa, Jardim"}'::jsonb),
    (NEW.id, 'Kids', 'kids', 'expense', '👶', '#4ECDC4', v_shopping, true, 'need',
      '{"en": "Kids", "es": "Niños", "pt": "Crianças"}'::jsonb),
    (NEW.id, 'Health and Beauty', 'health-beauty', 'expense', '💄', '#4ECDC4', v_shopping, true, 'want',
      '{"en": "Health and Beauty", "es": "Salud y Belleza", "pt": "Saúde e Beleza"}'::jsonb),
    (NEW.id, 'Jewels, Accessories', 'jewels', 'expense', '💎', '#4ECDC4', v_shopping, true, 'want',
      '{"en": "Jewels, Accessories", "es": "Joyas, Accesorios", "pt": "Jóias, Acessórios"}'::jsonb),
    (NEW.id, 'Clothes & Footwear', 'clothes', 'expense', '👕', '#4ECDC4', v_shopping, true, 'want',
      '{"en": "Clothes & Footwear", "es": "Ropa y Calzado", "pt": "Roupas e Calçados"}'::jsonb);

  -- ---- Housing children (must) ----
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, is_default, spending_nature, translations)
  VALUES
    (NEW.id, 'Property Insurance', 'property-insurance', 'expense', '🛡️', '#95E1D3', v_housing, true, 'must',
      '{"en": "Property Insurance", "es": "Seguro de Propiedad", "pt": "Seguro de Propriedade"}'::jsonb),
    (NEW.id, 'Maintenance, Repairs', 'maintenance', 'expense', '🔧', '#95E1D3', v_housing, true, 'must',
      '{"en": "Maintenance, Repairs", "es": "Mantenimiento, Reparaciones", "pt": "Manutenção, Reparos"}'::jsonb),
    (NEW.id, 'Services', 'housing-services', 'expense', '🔌', '#95E1D3', v_housing, true, 'must',
      '{"en": "Services", "es": "Servicios", "pt": "Serviços"}'::jsonb),
    (NEW.id, 'Energy, Utilities', 'utilities', 'expense', '💡', '#95E1D3', v_housing, true, 'must',
      '{"en": "Energy, Utilities", "es": "Energía, Servicios públicos", "pt": "Energia, Serviços públicos"}'::jsonb),
    (NEW.id, 'Mortgage', 'mortgage', 'expense', '🏦', '#95E1D3', v_housing, true, 'must',
      '{"en": "Mortgage", "es": "Hipoteca", "pt": "Hipoteca"}'::jsonb),
    (NEW.id, 'Rent', 'rent', 'expense', '🔑', '#95E1D3', v_housing, true, 'must',
      '{"en": "Rent", "es": "Arriendo", "pt": "Aluguel"}'::jsonb);

  -- ---- Transportation children (need) ----
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, is_default, spending_nature, translations)
  VALUES
    (NEW.id, 'Business Trips', 'business-trips', 'expense', '✈️', '#F38181', v_transportation, true, 'need',
      '{"en": "Business Trips", "es": "Viajes de Negocios", "pt": "Viagens de Negócios"}'::jsonb),
    (NEW.id, 'Long Distance', 'long-distance', 'expense', '🚄', '#F38181', v_transportation, true, 'need',
      '{"en": "Long Distance", "es": "Larga Distancia", "pt": "Longa Distância"}'::jsonb),
    (NEW.id, 'Taxi', 'taxi', 'expense', '🚕', '#F38181', v_transportation, true, 'need',
      '{"en": "Taxi", "es": "Taxi", "pt": "Táxi"}'::jsonb),
    (NEW.id, 'Public Transport', 'public-transport', 'expense', '🚌', '#F38181', v_transportation, true, 'need',
      '{"en": "Public Transport", "es": "Transporte público", "pt": "Transporte público"}'::jsonb);

  -- ---- Vehicle children (need) ----
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, is_default, spending_nature, translations)
  VALUES
    (NEW.id, 'Leasing', 'leasing', 'expense', '📋', '#AA96DA', v_vehicle, true, 'must',
      '{"en": "Leasing", "es": "Leasing", "pt": "Leasing"}'::jsonb),
    (NEW.id, 'Vehicle Insurance', 'vehicle-insurance', 'expense', '🛡️', '#AA96DA', v_vehicle, true, 'must',
      '{"en": "Vehicle Insurance", "es": "Seguro de Vehículo", "pt": "Seguro de Veículo"}'::jsonb),
    (NEW.id, 'Rentals', 'vehicle-rentals', 'expense', '🔑', '#AA96DA', v_vehicle, true, 'want',
      '{"en": "Rentals", "es": "Alquiler", "pt": "Aluguel"}'::jsonb),
    (NEW.id, 'Vehicle Maintenance', 'vehicle-maintenance', 'expense', '🔧', '#AA96DA', v_vehicle, true, 'need',
      '{"en": "Vehicle Maintenance", "es": "Mantenimiento de Vehículo", "pt": "Manutenção de Veículo"}'::jsonb),
    (NEW.id, 'Parking', 'parking', 'expense', '🅿️', '#AA96DA', v_vehicle, true, 'need',
      '{"en": "Parking", "es": "Estacionamiento", "pt": "Estacionamento"}'::jsonb),
    (NEW.id, 'Fuel', 'fuel', 'expense', '⛽', '#AA96DA', v_vehicle, true, 'need',
      '{"en": "Fuel", "es": "Combustible", "pt": "Combustível"}'::jsonb);

  -- ---- Life & Entertainment children (want) ----
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, is_default, spending_nature, translations)
  VALUES
    (NEW.id, 'Lottery, Gambling', 'lottery', 'expense', '🎰', '#FCBAD3', v_entertainment, true, 'want',
      '{"en": "Lottery, Gambling", "es": "Lotería, Apuestas", "pt": "Loteria, Apostas"}'::jsonb),
    (NEW.id, 'Alcohol, Tobacco', 'alcohol-tobacco', 'expense', '🍷', '#FCBAD3', v_entertainment, true, 'want',
      '{"en": "Alcohol, Tobacco", "es": "Alcohol, Tabaco", "pt": "Álcool, Tabaco"}'::jsonb),
    (NEW.id, 'Holiday, Trips, Hotels', 'holiday', 'expense', '🏖️', '#FCBAD3', v_entertainment, true, 'want',
      '{"en": "Holiday, Trips, Hotels", "es": "Vacaciones, Viajes, Hoteles", "pt": "Férias, Viagens, Hotéis"}'::jsonb),
    (NEW.id, 'Subscriptions & Streaming', 'subscriptions', 'expense', '📺', '#FCBAD3', v_entertainment, true, 'want',
      '{"en": "Subscriptions & Streaming", "es": "Suscripciones y Streaming", "pt": "Assinaturas e Streaming"}'::jsonb),
    (NEW.id, 'Education, Development', 'education', 'expense', '📖', '#FCBAD3', v_entertainment, true, 'need',
      '{"en": "Education, Development", "es": "Educación, Desarrollo", "pt": "Educação, Desenvolvimento"}'::jsonb),
    (NEW.id, 'Hobbies', 'hobbies', 'expense', '🎨', '#FCBAD3', v_entertainment, true, 'want',
      '{"en": "Hobbies", "es": "Pasatiempos", "pt": "Hobbies"}'::jsonb),
    (NEW.id, 'Life Events', 'life-events', 'expense', '🎉', '#FCBAD3', v_entertainment, true, 'want',
      '{"en": "Life Events", "es": "Eventos de Vida", "pt": "Eventos da Vida"}'::jsonb),
    (NEW.id, 'Culture, Sport Events', 'culture-events', 'expense', '🎭', '#FCBAD3', v_entertainment, true, 'want',
      '{"en": "Culture, Sport Events", "es": "Cultura, Eventos deportivos", "pt": "Cultura, Eventos esportivos"}'::jsonb),
    (NEW.id, 'Active Sport, Fitness', 'fitness', 'expense', '💪', '#FCBAD3', v_entertainment, true, 'need',
      '{"en": "Active Sport, Fitness", "es": "Deporte, Fitness", "pt": "Esporte, Fitness"}'::jsonb),
    (NEW.id, 'Wellness, Beauty', 'wellness', 'expense', '💆', '#FCBAD3', v_entertainment, true, 'want',
      '{"en": "Wellness, Beauty", "es": "Bienestar, Belleza", "pt": "Bem-estar, Beleza"}'::jsonb),
    (NEW.id, 'Health Care, Doctor', 'health-care', 'expense', '⚕️', '#FCBAD3', v_entertainment, true, 'must',
      '{"en": "Health Care, Doctor", "es": "Salud, Médico", "pt": "Saúde, Médico"}'::jsonb),
    (NEW.id, 'Personal Care', 'personal-care', 'expense', '💇', '#FDA7DF', v_entertainment, true, 'need',
      '{"en": "Personal Care", "es": "Cuidado personal", "pt": "Cuidados pessoais"}'::jsonb);

  -- ---- Technology & Internet children (need) ----
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, is_default, spending_nature, translations)
  VALUES
    (NEW.id, 'Postal Services', 'postal', 'expense', '📮', '#FFFFD2', v_technology, true, 'need',
      '{"en": "Postal Services", "es": "Servicios postales", "pt": "Serviços postais"}'::jsonb),
    (NEW.id, 'Software, Apps, Games', 'software', 'expense', '🎮', '#FFFFD2', v_technology, true, 'want',
      '{"en": "Software, Apps, Games", "es": "Software, Apps, Juegos", "pt": "Software, Apps, Jogos"}'::jsonb),
    (NEW.id, 'Internet', 'internet', 'expense', '🌐', '#FFFFD2', v_technology, true, 'must',
      '{"en": "Internet", "es": "Internet", "pt": "Internet"}'::jsonb),
    (NEW.id, 'Telephony, Mobile Phone', 'phone', 'expense', '📱', '#FFFFD2', v_technology, true, 'must',
      '{"en": "Telephony, Mobile Phone", "es": "Telefonía, Celular", "pt": "Telefonia, Celular"}'::jsonb),
    (NEW.id, 'Cloud Services', 'cloud-services', 'expense', '☁️', '#74B9FF', v_technology, true, 'want',
      '{"en": "Cloud Services", "es": "Servicios en la nube", "pt": "Serviços em nuvem"}'::jsonb);

  -- ---- Financial Expenses children (must) ----
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, is_default, spending_nature, translations)
  VALUES
    (NEW.id, 'Child Support', 'child-support-expense', 'expense', '👶', '#A8D8EA', v_financial, true, 'must',
      '{"en": "Child Support", "es": "Pensión alimenticia", "pt": "Pensão alimentícia"}'::jsonb),
    (NEW.id, 'Charges, Fees', 'fees', 'expense', '💵', '#A8D8EA', v_financial, true, 'must',
      '{"en": "Charges, Fees", "es": "Cargos, Comisiones", "pt": "Taxas, Tarifas"}'::jsonb),
    (NEW.id, 'Advisory', 'advisory', 'expense', '📊', '#A8D8EA', v_financial, true, 'want',
      '{"en": "Advisory", "es": "Asesoría", "pt": "Consultoria"}'::jsonb),
    (NEW.id, 'Fines', 'fines', 'expense', '🚫', '#A8D8EA', v_financial, true, 'must',
      '{"en": "Fines", "es": "Multas", "pt": "Multas"}'::jsonb),
    (NEW.id, 'Loans, Interests', 'loans', 'expense', '🏦', '#A8D8EA', v_financial, true, 'must',
      '{"en": "Loans, Interests", "es": "Préstamos, Intereses", "pt": "Empréstimos, Juros"}'::jsonb),
    (NEW.id, 'Insurances', 'insurances', 'expense', '🛡️', '#A8D8EA', v_financial, true, 'must',
      '{"en": "Insurances", "es": "Seguros", "pt": "Seguros"}'::jsonb),
    (NEW.id, 'Taxes', 'taxes', 'expense', '📋', '#A8D8EA', v_financial, true, 'must',
      '{"en": "Taxes", "es": "Impuestos", "pt": "Impostos"}'::jsonb),
    (NEW.id, 'Debt Payment', 'debt-payment', 'expense', '💳', '#E17055', v_financial, true, 'must',
      '{"en": "Debt Payment", "es": "Pago de deuda", "pt": "Pagamento de dívida"}'::jsonb);

  -- ---- Investments children (none) ----
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, is_default, spending_nature, translations)
  VALUES
    (NEW.id, 'Art & Collectibles', 'art-collectibles', 'expense', '🖼️', '#845EC2', v_investments, true, 'none',
      '{"en": "Art & Collectibles", "es": "Arte y Coleccionables", "pt": "Arte e Colecionáveis"}'::jsonb),
    (NEW.id, 'Savings', 'savings-category', 'expense', '🏦', '#845EC2', v_investments, true, 'none',
      '{"en": "Savings", "es": "Ahorros", "pt": "Poupança"}'::jsonb),
    (NEW.id, 'Financial Investments', 'financial-investments', 'expense', '📈', '#845EC2', v_investments, true, 'none',
      '{"en": "Financial Investments", "es": "Inversiones financieras", "pt": "Investimentos financeiros"}'::jsonb),
    (NEW.id, 'Vehicle Investments', 'vehicle-investments', 'expense', '🚗', '#845EC2', v_investments, true, 'none',
      '{"en": "Vehicle Investments", "es": "Inversiones en Vehículos", "pt": "Investimentos em Veículos"}'::jsonb),
    (NEW.id, 'Realty', 'realty', 'expense', '🏢', '#845EC2', v_investments, true, 'none',
      '{"en": "Realty", "es": "Bienes raíces", "pt": "Imóveis"}'::jsonb);

  -- ---- Income children (none) ----
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, is_default, spending_nature, translations)
  VALUES
    (NEW.id, 'Gifts (Income)', 'gifts-income', 'income', '🎁', '#51CF66', v_income, true, 'none',
      '{"en": "Gifts (Income)", "es": "Regalos (Ingreso)", "pt": "Presentes (Renda)"}'::jsonb),
    (NEW.id, 'Child Support (Income)', 'child-support-income', 'income', '👶', '#51CF66', v_income, true, 'none',
      '{"en": "Child Support (Income)", "es": "Pensión alimenticia (Ingreso)", "pt": "Pensão alimentícia (Renda)"}'::jsonb),
    (NEW.id, 'Refunds', 'refunds', 'income', '↩️', '#51CF66', v_income, true, 'none',
      '{"en": "Refunds", "es": "Reembolsos", "pt": "Reembolsos"}'::jsonb),
    (NEW.id, 'Lottery, Gambling (Income)', 'lottery-income', 'income', '🎰', '#51CF66', v_income, true, 'none',
      '{"en": "Lottery, Gambling (Income)", "es": "Lotería, Apuestas (Ingreso)", "pt": "Loteria, Apostas (Renda)"}'::jsonb),
    (NEW.id, 'Checks, Coupons', 'checks', 'income', '🎫', '#51CF66', v_income, true, 'none',
      '{"en": "Checks, Coupons", "es": "Cheques, Cupones", "pt": "Cheques, Cupons"}'::jsonb),
    (NEW.id, 'Lending, Renting', 'lending', 'income', '🤝', '#51CF66', v_income, true, 'none',
      '{"en": "Lending, Renting", "es": "Préstamos, Alquiler", "pt": "Empréstimos, Aluguel"}'::jsonb),
    (NEW.id, 'Dues & Grants', 'grants', 'income', '🎓', '#51CF66', v_income, true, 'none',
      '{"en": "Dues & Grants", "es": "Cuotas y Becas", "pt": "Cotas e Bolsas"}'::jsonb),
    (NEW.id, 'Rental Income', 'rental-income', 'income', '🏠', '#51CF66', v_income, true, 'none',
      '{"en": "Rental Income", "es": "Ingresos por Alquiler", "pt": "Renda de Aluguel"}'::jsonb),
    (NEW.id, 'Sale', 'sale', 'income', '💰', '#51CF66', v_income, true, 'none',
      '{"en": "Sale", "es": "Venta", "pt": "Venda"}'::jsonb),
    (NEW.id, 'Interests, Dividends', 'dividends', 'income', '📈', '#51CF66', v_income, true, 'none',
      '{"en": "Interests, Dividends", "es": "Intereses, Dividendos", "pt": "Juros, Dividendos"}'::jsonb),
    (NEW.id, 'Wage, Invoices', 'wage', 'income', '💼', '#51CF66', v_income, true, 'none',
      '{"en": "Wage, Invoices", "es": "Salario, Facturas", "pt": "Salário, Faturas"}'::jsonb);

  -- ---- Others children (none) ----
  INSERT INTO public.categories (user_id, name, slug, type, icon, color, parent_id, is_default, spending_nature, translations)
  VALUES
    (NEW.id, 'Uncategorized', 'uncategorized', 'expense', '❌', '#95A5A6', v_others, true, 'none',
      '{"en": "Uncategorized", "es": "Sin categoría", "pt": "Sem categoria"}'::jsonb),
    (NEW.id, 'Charity, Gifts', 'charity', 'expense', '❤️', '#95A5A6', v_others, true, 'want',
      '{"en": "Charity, Gifts", "es": "Caridad, Donaciones", "pt": "Caridade, Doações"}'::jsonb);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
