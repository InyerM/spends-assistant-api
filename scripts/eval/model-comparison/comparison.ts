export interface Row {
  reference: string;
  amount: number;
  currency: string;
  date: string;
}
export function validRows(value: unknown): value is Row[] {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        row &&
        typeof row.reference === 'string' &&
        typeof row.amount === 'number' &&
        Number.isFinite(row.amount) &&
        typeof row.currency === 'string' &&
        /^[A-Z]{3}$/.test(row.currency) &&
        typeof row.date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
        Number.isFinite(Date.parse(row.date)) &&
        new Date(row.date).toISOString().slice(0, 10) === row.date
    )
  );
}
export function scoreRows(expected: Row[], actual: unknown) {
  const schemaValid = validRows(actual);
  const rows = schemaValid ? actual : [];
  const fields = ['amount', 'currency', 'date'] as const;
  const matched = new Set<string>();
  const correct = { amount: 0, currency: 0, date: 0 };
  let exact = 0;
  for (const row of rows) {
    const target = expected.find((item) => item.reference === row.reference);
    if (!target || matched.has(row.reference)) continue;
    matched.add(row.reference);
    for (const field of fields) if (row[field] === target[field]) correct[field]++;
    if (fields.every((field) => row[field] === target[field])) exact++;
  }
  return {
    schemaValid,
    expected: expected.length,
    returned: rows.length,
    coverage: matched.size,
    exact,
    correct,
    pass: schemaValid && exact === expected.length && rows.length === expected.length
  };
}
export async function withFallback(
  primary: () => Promise<unknown>,
  secondary: () => Promise<unknown>,
  validate: (data: unknown) => boolean = () => true
) {
  let data: unknown;
  try {
    data = await primary();
  } catch {
    data = null;
  }
  const valid =
    data !== null &&
    typeof data === 'object' &&
    'rows' in data &&
    validRows(data.rows) &&
    validate(data);
  const result = valid ? data : await secondary();
  const accepted =
    result !== null &&
    typeof result === 'object' &&
    'rows' in result &&
    validRows(result.rows) &&
    validate(result);
  return { data: result, fallback: !valid, accepted };
}
export function reserveBudget(spent: number, reservation: number, limit: number) {
  return (
    [spent, reservation, limit].every(Number.isFinite) &&
    spent >= 0 &&
    reservation >= 0 &&
    spent + reservation <= limit
  );
}
export function parseModelJson(content: string): {
  data: Record<string, unknown> | null;
  strict: boolean;
} {
  for (const [index, text] of [
    content,
    content
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
  ].entries()) {
    try {
      const data: unknown = JSON.parse(text);
      if (data && typeof data === 'object' && !Array.isArray(data))
        return { data: data as Record<string, unknown>, strict: index === 0 };
    } catch {
      /* Keep malformed content out of reports. */
    }
  }
  return { data: null, strict: false };
}
