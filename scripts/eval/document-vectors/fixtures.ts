export interface SyntheticTransaction {
  id: string;
  amount: number;
  date: string;
  description: string;
  rawText: string;
}

export interface SyntheticObservation {
  id: string;
  amount: number;
  date: string;
  description: string;
  counterparty: string;
  reference: string | null;
}

export interface SyntheticCase {
  id: string;
  split: 'development' | 'holdout';
  source: 'receipt' | 'bank_screenshot' | 'nequi_message';
  observation: SyntheticObservation;
  transactions: SyntheticTransaction[];
  expectedTransactionId: string | null;
}

const at = (
  id: string,
  amount: number,
  description: string,
  date = '2026-09-28'
): SyntheticTransaction => ({
  id,
  amount,
  date,
  description,
  rawText: ''
});

const observed = (
  id: string,
  amount: number,
  description: string,
  counterparty = ''
): SyntheticObservation => ({
  id,
  amount,
  date: '2026-09-28',
  description,
  counterparty,
  reference: null
});

// Invented names, amounts, and dates only. Never replace these with exported account data.
export const SYNTHETIC_CASES: SyntheticCase[] = [
  {
    id: 'dev-receipt-breakfast',
    split: 'development',
    source: 'receipt',
    observation: observed('o-dev-breakfast', 14500, 'desayuno capuchino y pan', 'Café Aurora'),
    transactions: [
      at('a-dev-market', 14500, 'Compra en tienda de barrio'),
      at('z-dev-cafe', 14500, 'Pago cafeteria Aurora')
    ],
    expectedTransactionId: 'z-dev-cafe'
  },
  {
    id: 'dev-bank-pharmacy',
    split: 'development',
    source: 'bank_screenshot',
    observation: observed('o-dev-medicine', 28000, 'medicamento para alergia', 'Droguería Lirio'),
    transactions: [
      at('a-dev-taxi', 28000, 'Servicio de transporte'),
      at('z-dev-pharmacy', 28000, 'Compra farmacia Lirio')
    ],
    expectedTransactionId: 'z-dev-pharmacy'
  },
  {
    id: 'dev-nequi-lunch',
    split: 'development',
    source: 'nequi_message',
    observation: observed('o-dev-lunch', 22000, 'almuerzo menú del día', 'Nequi restaurante Olivo'),
    transactions: [
      at('a-dev-friend', 22000, 'Pago Nequi a amigo'),
      at('z-dev-restaurant', 22000, 'Comida restaurante Olivo')
    ],
    expectedTransactionId: 'z-dev-restaurant'
  },
  {
    id: 'dev-no-match',
    split: 'development',
    source: 'receipt',
    observation: observed('o-dev-unknown', 17500, 'parqueadero de bicicleta', 'Parqueadero Este'),
    transactions: [
      at('a-dev-book', 17500, 'Compra libro usado'),
      at('z-dev-food', 17500, 'Mercado frutas')
    ],
    expectedTransactionId: null
  },
  {
    id: 'holdout-bank-transport',
    split: 'holdout',
    source: 'bank_screenshot',
    observation: observed('o-holdout-bus', 3200, 'pasaje de transporte público', 'Ruta Sur'),
    transactions: [
      at('a-holdout-snack', 3200, 'Compra dulce'),
      at('z-holdout-bus', 3200, 'Recarga bus urbano')
    ],
    expectedTransactionId: 'z-holdout-bus'
  },
  {
    id: 'holdout-receipt-utilities',
    split: 'holdout',
    source: 'receipt',
    observation: observed(
      'o-holdout-electricity',
      82000,
      'factura energía del apartamento',
      'Luz del Valle'
    ),
    transactions: [
      at('a-holdout-clothes', 82000, 'Compra de ropa'),
      at('z-holdout-power', 82000, 'Pago servicio de electricidad')
    ],
    expectedTransactionId: 'z-holdout-power'
  },
  {
    id: 'holdout-nequi-dinner',
    split: 'holdout',
    source: 'nequi_message',
    observation: observed(
      'o-holdout-dinner',
      36500,
      'comida nocturna pizza',
      'Nequi Pizzería Nube'
    ),
    transactions: [
      at('a-holdout-fuel', 36500, 'Combustible'),
      at('z-holdout-pizza', 36500, 'Cena pizzería Nube')
    ],
    expectedTransactionId: 'z-holdout-pizza'
  },
  {
    id: 'holdout-no-match',
    split: 'holdout',
    source: 'bank_screenshot',
    observation: observed('o-holdout-unknown', 51000, 'reparación de bicicleta', 'Taller Roble'),
    transactions: [
      at('a-holdout-groceries', 51000, 'Mercado semanal'),
      at('z-holdout-dentist', 51000, 'Consulta odontológica')
    ],
    expectedTransactionId: null
  }
];
