import { scoreRows, type Row } from './comparison';
export interface HardRow extends Row {
  direction: 'debit' | 'credit';
}
export const HARD_CASES: readonly {
  id: string;
  lines: readonly string[];
  rows: readonly HardRow[];
  angle: number;
  blur: number;
  contrast: number;
}[] = Object.freeze(
  [
    {
      id: 'receipt-es-skew',
      angle: 2.3,
      blur: 0.55,
      contrast: 0.72,
      lines: [
        'RECIBO SINTETICO / SYNTHETIC - DEMO CAFE',
        'Fecha 01/11/2026 (DD/MM/YYYY)',
        'Referencia | Importe impreso | Moneda | Movimiento',
        'CAFE-01 | 12.345,67 | COP | Debito',
        'CAFE-02 | -2.345,67 | COP | Credito',
        'CAFE-03 | +12,50 | USD | Debito',
        'CAFE-04 | -0,99 | USD | Credito',
        'TOTAL NO ES MOVIMIENTO: COP 10.000,00'
      ],
      rows: [
        {
          reference: 'CAFE-01',
          amount: 12345.67,
          currency: 'COP',
          date: '2026-11-01',
          direction: 'debit'
        },
        {
          reference: 'CAFE-02',
          amount: -2345.67,
          currency: 'COP',
          date: '2026-11-01',
          direction: 'credit'
        },
        {
          reference: 'CAFE-03',
          amount: 12.5,
          currency: 'USD',
          date: '2026-11-01',
          direction: 'debit'
        },
        {
          reference: 'CAFE-04',
          amount: -0.99,
          currency: 'USD',
          date: '2026-11-01',
          direction: 'credit'
        }
      ]
    },
    {
      id: 'statement-mixed-low-contrast',
      angle: -1.7,
      blur: 0.7,
      contrast: 0.5,
      lines: [
        'EXTRACTO SINTETICO / SYNTHETIC STATEMENT',
        'Dates DD/MM/YYYY. Amount locale printed per row.',
        'Reference | Date | Printed amount | Currency | Direction',
        'MIX-01 | 02/11/2026 | 1.234,56 | COP | Debito',
        'MIX-02 | 03/11/2026 | -1,234.56 | USD | Credit',
        'MIX-03 | 04/11/2026 | +9,876.54 | USD | Debit',
        'MIX-04 | 05/11/2026 | -9.876,54 | COP | Credito',
        'MIX-05 | 06/11/2026 | 0,01 | COP | Debito',
        'Opening balance COP 999.999,99 - NOT a movement'
      ],
      rows: [
        {
          reference: 'MIX-01',
          amount: 1234.56,
          currency: 'COP',
          date: '2026-11-02',
          direction: 'debit'
        },
        {
          reference: 'MIX-02',
          amount: -1234.56,
          currency: 'USD',
          date: '2026-11-03',
          direction: 'credit'
        },
        {
          reference: 'MIX-03',
          amount: 9876.54,
          currency: 'USD',
          date: '2026-11-04',
          direction: 'debit'
        },
        {
          reference: 'MIX-04',
          amount: -9876.54,
          currency: 'COP',
          date: '2026-11-05',
          direction: 'credit'
        },
        {
          reference: 'MIX-05',
          amount: 0.01,
          currency: 'COP',
          date: '2026-11-06',
          direction: 'debit'
        }
      ]
    },
    {
      id: 'dense-bilingual-blur',
      angle: 1.1,
      blur: 0.85,
      contrast: 0.64,
      lines: [
        'SYNTHETIC DENSE LEDGER / MOVIMIENTOS',
        'Dates DD/MM/YYYY; amounts Colombian locale.',
        'Reference | Date | Printed amount | Currency | Direction',
        ...Array.from(
          { length: 12 },
          (_, i) =>
            `DENSE-${String(i + 1).padStart(2, '0')} | ${String(i + 1).padStart(2, '0')}/10/2026 | ${i % 3 === 0 ? '-' : i % 3 === 1 ? '+' : ''}${i + 1}.001,${String(i + 1).padStart(2, '0')} | ${i % 2 ? 'USD' : 'COP'} | ${i % 2 ? 'Credit' : 'Debito'}`
        ),
        'Closing balance COP 0,00 - NOT a movement'
      ],
      rows: Array.from({ length: 12 }, (_, i) => ({
        reference: `DENSE-${String(i + 1).padStart(2, '0')}`,
        amount: (i % 3 === 0 ? -1 : 1) * ((i + 1) * 1000 + 1 + (i + 1) / 100),
        currency: i % 2 ? 'USD' : 'COP',
        date: `2026-10-${String(i + 1).padStart(2, '0')}`,
        direction: i % 2 ? 'credit' : 'debit'
      }))
    }
  ].map((fixture) =>
    Object.freeze({
      ...fixture,
      lines: Object.freeze(fixture.lines),
      rows: Object.freeze(fixture.rows.map((row) => Object.freeze(row as HardRow)))
    })
  )
);
export function parseHardJson(content: string): {
  data: Record<string, unknown> | null;
  strict: boolean;
} {
  const fence = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(content);
  try {
    const data: unknown = JSON.parse(fence ? fence[1] : content);
    return data && typeof data === 'object' && !Array.isArray(data)
      ? { data: data as Record<string, unknown>, strict: !fence }
      : { data: null, strict: false };
  } catch {
    return { data: null, strict: false };
  }
}
export function scoreHardRows(expected: readonly HardRow[], actual: unknown) {
  const basic = scoreRows([...expected], actual);
  const rows = basic.schemaValid ? (actual as (Row & { direction?: unknown })[]) : [];
  const matched = new Set<string>();
  let signCorrect = 0;
  let directionCorrect = 0;
  let duplicates = 0;
  let unexpected = 0;
  for (const row of rows) {
    if (matched.has(row.reference)) {
      duplicates++;
      continue;
    }
    matched.add(row.reference);
    const target = expected.find((item) => item.reference === row.reference);
    if (!target) {
      unexpected++;
      continue;
    }
    if (Math.sign(row.amount) === Math.sign(target.amount)) signCorrect++;
    if (row.direction === target.direction) directionCorrect++;
  }
  const schemaValid =
    basic.schemaValid &&
    rows.every((row) => row.direction === 'debit' || row.direction === 'credit');
  return {
    ...basic,
    schemaValid,
    signCorrect,
    directionCorrect,
    duplicates,
    unexpected,
    pass: basic.pass && schemaValid && directionCorrect === expected.length
  };
}
