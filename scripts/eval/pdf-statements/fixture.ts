/** Fixed synthetic pages only. No caller-supplied PDF path enters this benchmark. */
export interface ExpectedRow {
  reference: string;
  amount: number;
  date: string;
  currency: 'COP';
  description: string;
}
export interface SyntheticPage {
  pageNumber: number;
  rows: ExpectedRow[];
}

export const SYNTHETIC_PAGES: SyntheticPage[] = [
  {
    pageNumber: 1,
    rows: [
      {
        reference: 'REF-101',
        amount: 12345,
        date: '2026-09-01',
        currency: 'COP',
        description: 'Grocery debit'
      },
      {
        reference: 'REF-102',
        amount: 6789,
        date: '2026-09-02',
        currency: 'COP',
        description: 'Transfer fee'
      }
    ]
  },
  {
    pageNumber: 2,
    rows: [
      {
        reference: 'REF-201',
        amount: 12345,
        date: '2026-09-01',
        currency: 'COP',
        description: 'Repeated amount debit'
      },
      {
        reference: 'REF-202',
        amount: 22222,
        date: '2026-09-03',
        currency: 'COP',
        description: 'Payroll credit'
      }
    ]
  },
  { pageNumber: 3, rows: [] },
  {
    pageNumber: 4,
    rows: Array.from({ length: 15 }, (_, index) => ({
      reference: `REF-${401 + index}`,
      amount: 3000 + index * 37,
      date: '2026-09-04',
      currency: 'COP' as const,
      description: `Dense page movement ${index + 1}`
    }))
  },
  {
    pageNumber: 5,
    rows: [
      {
        reference: 'REF-501',
        amount: 45555,
        date: '2026-09-05',
        currency: 'COP',
        description: 'Utilities debit'
      },
      {
        reference: 'REF-502',
        amount: 98765,
        date: '2026-09-06',
        currency: 'COP',
        description: 'Deposit credit'
      }
    ]
  }
];

function pdfString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function contentFor(page: SyntheticPage): string {
  const lines = [
    `SYNTHETIC BANK STATEMENT - PAGE ${page.pageNumber} OF ${SYNTHETIC_PAGES.length}`,
    'TEST FIXTURE ONLY - NO PERSONAL DATA',
    'Date | Reference | Amount | Description',
    ...page.rows.map(
      (row) => `${row.date} | ${row.reference} | ${row.currency} ${row.amount} | ${row.description}`
    ),
    ...(page.rows.length === 0 ? ['NO MOVEMENTS ON THIS PAGE'] : [])
  ];
  return `BT /F1 12 Tf 42 765 Td 20 TL ${lines.map((line) => `(${pdfString(line)}) Tj T*`).join(' ')} ET`;
}

export function buildSyntheticStatementPdf(): Buffer {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${SYNTHETIC_PAGES.map((page) => `${2 * page.pageNumber + 2} 0 R`).join(' ')}] /Count ${SYNTHETIC_PAGES.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  for (const page of SYNTHETIC_PAGES) {
    const content = contentFor(page);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${2 * page.pageNumber + 3} 0 R >>`
    );
    objects.push(
      `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}\nendstream`
    );
  }
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output, 'ascii'));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output, 'ascii');
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, 'ascii');
}
