import type { Fixture } from './types';

/**
 * Fixed clock for every run so relative dates ("ayer", "el lunes") have one correct answer.
 * 2026-03-18 is a Wednesday in America/Bogota.
 */
export const REFERENCE_DATE = '2026-03-18';
export const REFERENCE_TIME = '10:00';

/**
 * Synthetic fixtures written for this harness. They mimic message formats only: every
 * merchant alias, card suffix, name, and amount is invented. Do not add real messages;
 * `checkFixturePrivacy()` rejects common PII shapes, but it cannot prove a text is synthetic.
 */
export const FIXTURES: Fixture[] = [
  {
    id: 'sms-debit-grocery',
    category: 'bank_sms',
    text: 'Bancolombia: Compraste $84.500,00 en EXITO DEMO con tu T.Deb *1111, el 14/03/2026 a las 18:22',
    expected: {
      is_transaction: true,
      fields: {
        amount: 84500,
        category: 'groceries',
        bank: 'bancolombia',
        payment_type: 'debit',
        // The raw notification text does not identify its delivery channel.
        source: 'manual',
        original_date: '14/03/2026',
        original_time: '18:22',
        last_four: '1111',
        account_type: 'checking'
      }
    }
  },
  {
    id: 'sms-credit-streaming',
    category: 'bank_sms',
    text: 'Bancolombia: Compraste $44.900,00 en NETFLIX.COM con tu T.Cred *2222, el 02/03/2026 a las 07:05',
    expected: {
      is_transaction: true,
      fields: {
        amount: 44900,
        category: 'streaming',
        bank: 'bancolombia',
        payment_type: 'credit',
        original_date: '02/03/2026',
        original_time: '07:05',
        last_four: '2222',
        account_type: 'credit_card'
      }
    }
  },
  {
    id: 'email-credit-fuel',
    category: 'bank_email',
    text: 'Bancolombia te informa: Compraste $120.000,00 en EDS TERPEL DEMO con tu Crédito *3333, el 11/03/2026 a las 21:40. Si no reconoces esta compra comunícate con nosotros.',
    expected: {
      is_transaction: true,
      fields: {
        amount: 120000,
        category: 'fuel',
        bank: 'bancolombia',
        payment_type: 'credit',
        original_date: '11/03/2026',
        original_time: '21:40',
        last_four: '3333',
        account_type: 'credit_card'
      }
    }
  },
  {
    id: 'transfer-outgoing-savings',
    category: 'transfer',
    text: 'Bancolombia: Transferiste $250.000 desde tu cuenta de ahorros *4444 a la cuenta *5555 el 09/03/2026 a las 08:15',
    expected: {
      is_transaction: true,
      fields: {
        amount: 250000,
        bank: 'bancolombia',
        payment_type: 'transfer',
        original_date: '09/03/2026',
        original_time: '08:15',
        last_four: '4444',
        account_type: 'savings'
      }
    }
  },
  {
    id: 'transfer-manual-english',
    category: 'transfer',
    text: 'sent 300k to my savings account from bancolombia today',
    expected: {
      is_transaction: true,
      fields: {
        amount: 300000,
        bank: 'bancolombia',
        payment_type: 'transfer',
        original_date: '18/03/2026',
        account_type: 'savings'
      }
    }
  },
  {
    id: 'nequi-payment',
    category: 'nequi',
    text: 'Nequi: Pagaste $18.000 en TIENDA DEMO. Saldo: $42.350',
    expected: {
      is_transaction: true,
      fields: {
        amount: 18000,
        bank: 'nequi',
        payment_type: 'unknown',
        source: 'nequi_sms'
      }
    }
  },
  {
    id: 'nequi-send-to-contact',
    category: 'nequi',
    text: 'Nequi: Enviaste $35.000 a CONTACTO DEMO. Saldo: $7.650',
    expected: {
      is_transaction: true,
      fields: {
        amount: 35000,
        bank: 'nequi',
        payment_type: 'transfer',
        source: 'nequi_sms',
        account_type: ['savings', null]
      }
    }
  },
  {
    id: 'manual-restaurant-k',
    category: 'manual',
    text: '32k en rappi',
    expected: {
      is_transaction: true,
      fields: {
        amount: 32000,
        category: 'restaurant',
        bank: 'cash',
        payment_type: 'cash',
        source: 'manual',
        original_date: null,
        original_time: null
      }
    }
  },
  {
    id: 'manual-taxi-mil',
    category: 'manual',
    text: 'uber 15mil',
    expected: {
      is_transaction: true,
      fields: { amount: 15000, category: 'taxi', source: 'manual' }
    }
  },
  {
    id: 'non-tx-spending-summary',
    category: 'non_transaction',
    text: 'Bancolombia: tus gastos entre enero y febrero cambiaron en $512.300',
    expected: { is_transaction: false }
  },
  {
    id: 'non-tx-otp',
    category: 'non_transaction',
    text: 'Tu clave dinamica es 482913. No la compartas con nadie.',
    expected: { is_transaction: false }
  },
  {
    id: 'non-tx-promo',
    category: 'non_transaction',
    text: 'Bancolombia: Activa tu tarjeta de credito y recibe 0% de cuota de manejo el primer mes',
    expected: { is_transaction: false }
  },
  {
    id: 'non-tx-reminder',
    category: 'non_transaction',
    text: 'Recuerda que tu cuota de $210.000 vence el 25/03/2026. Paga a tiempo y evita intereses.',
    expected: { is_transaction: false }
  },
  {
    id: 'date-ayer',
    category: 'ambiguous_date',
    text: 'ayer almuerzo 25mil',
    expected: {
      is_transaction: true,
      fields: { amount: 25000, category: 'restaurant', original_date: '17/03/2026' }
    }
  },
  {
    id: 'date-el-lunes',
    category: 'ambiguous_date',
    text: 'el lunes pague 60k de gimnasio',
    expected: {
      is_transaction: true,
      fields: { amount: 60000, category: 'fitness', original_date: '16/03/2026' }
    }
  },
  {
    id: 'date-amount-looks-like-day',
    category: 'ambiguous_date',
    text: 'pan de hoy 2500 a las 3 de la tarde',
    expected: {
      is_transaction: true,
      fields: {
        amount: 2500,
        category: 'groceries',
        original_date: '18/03/2026',
        original_time: '15:00'
      }
    }
  },
  {
    id: 'date-day-of-month',
    category: 'ambiguous_date',
    text: 'el 5 pague el arriendo 1.200.000',
    expected: {
      is_transaction: true,
      fields: { amount: 1200000, category: 'rent', original_date: '05/03/2026' }
    }
  }
];

const PII_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'email address', pattern: /[\w.+-]+@[\w-]+\.[\w.]+/ },
  { name: 'long digit run (phone, card, or ID)', pattern: /\d{7,}/ },
  { name: 'spaced card number', pattern: /\b\d{4}[ -]\d{4}[ -]\d{4}\b/ },
  { name: 'Colombian mobile number', pattern: /\b3\d{2}[ -]?\d{3}[ -]?\d{4}\b/ },
  { name: 'URL with path or query', pattern: /https?:\/\/\S+/ }
];

/** Returns one message per PII-shaped match. An empty list means the fixture set passes. */
export function checkFixturePrivacy(fixtures: Fixture[]): string[] {
  const problems: string[] = [];
  for (const fixture of fixtures) {
    for (const { name, pattern } of PII_PATTERNS) {
      if (pattern.test(fixture.text)) problems.push(`${fixture.id}: contains ${name}`);
    }
  }
  return problems;
}

/** Structural checks so a broken fixture fails offline instead of skewing a paid run. */
export function checkFixtureShape(fixtures: Fixture[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const fixture of fixtures) {
    if (ids.has(fixture.id)) problems.push(`${fixture.id}: duplicate id`);
    ids.add(fixture.id);
    if (!fixture.text.trim()) problems.push(`${fixture.id}: empty text`);
    const fieldCount = Object.keys(fixture.expected.fields ?? {}).length;
    if (fixture.expected.is_transaction && fieldCount === 0) {
      problems.push(`${fixture.id}: transaction fixture scores no fields`);
    }
    if (!fixture.expected.is_transaction && fieldCount > 0) {
      problems.push(`${fixture.id}: non-transaction fixture should not score fields`);
    }
  }
  return problems;
}
