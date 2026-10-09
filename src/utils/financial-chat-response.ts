interface ChatSource {
  id: string;
  record: Record<string, unknown>;
}

/** Reject unsupported literals; financial interpretation still requires evaluation. */
export function validateChatAnswer(
  value: unknown,
  sources: ChatSource[]
): { answer: string; citations: string[]; insufficientContext?: true } {
  if (!value || typeof value !== 'object') throw new Error('Invalid grounded response');
  const data = value as Record<string, unknown>;
  if (
    typeof data.answer !== 'string' ||
    !data.answer.trim() ||
    data.answer.length > 12000 ||
    !Array.isArray(data.citations) ||
    data.citations.length > 20 ||
    data.citations.some(
      (id) => typeof id !== 'string' || !sources.some((source) => source.id === id)
    ) ||
    /https?:\/\/|\]\(/i.test(data.answer)
  ) {
    throw new Error('Invalid grounded response');
  }
  const cited = sources.filter((source) => (data.citations as string[]).includes(source.id));
  const knownNumbers = new Set<number>();
  for (const source of cited) {
    for (const field of ['amount', 'balance', 'date', 'created_at']) {
      const value = source.record[field];
      if (typeof value === 'number') knownNumbers.add(value);
      if (typeof value === 'string') {
        for (const token of value.match(/\d+(?:\.\d+)?/g) ?? []) knownNumbers.add(Number(token));
      }
    }
  }
  for (const token of data.answer.match(/\d+(?:[.,]\d+)*/g) ?? []) {
    const candidates = [
      Number(token),
      Number(token.replace(/,/g, '')),
      Number(token.replace(/\./g, '').replace(',', '.'))
    ];
    if (!candidates.some((number) => knownNumbers.has(number)))
      throw new Error('Unsupported numerical claim');
  }
  const currencies = new Set(cited.map((source) => source.record.currency));
  for (const currency of data.answer.match(/\b(?:COP|USD|EUR|GBP|USDT|BTC)\b/g) ?? []) {
    if (!currencies.has(currency)) throw new Error('Unsupported currency claim');
  }
  if (data.citations.length === 0) {
    return {
      answer: 'There is not enough verified context to answer this question.',
      citations: [],
      insufficientContext: true
    };
  }
  const recommendation =
    /(?:should|recommend|suggest|deber[ií]as?|recomiendo|sugiero).{0,35}(?:buy|sell|hold|comprar|vender|mantener).{0,80}(?:stock|share|securit|bond|ETF|crypto|acci[oó]n|acciones|bono)/iu;
  const directSecurityInstruction =
    /(?:buy|sell|hold|compra[r]?|compre|vend[ae]r?|manten[ge]a|manter).{0,80}(?:stock|share|securit|bond|ETF|crypto|acci[oó]n|acciones|aç[ãõ]o|ações|bono)/iu;
  const tickerInstruction = /\b(?:[Bb]uy|[Ss]ell|[Hh]old)\s+[A-Z]{2,6}\b/u;
  if (
    recommendation.test(data.answer) ||
    directSecurityInstruction.test(data.answer) ||
    tickerInstruction.test(data.answer)
  )
    throw new Error('Unsupported investment recommendation');
  return { answer: data.answer, citations: [...new Set(data.citations as string[])] };
}
