import type { ParsedExpense } from '../types/expense';
import type { CacheService } from '../services/cache.service';
import { completeJson } from '../ai/openrouter';
import { buildSystemPrompt } from '../constants/parse-expens-system-prompt';
import { getCurrentColombiaTimes } from '../utils/date';

export interface ParseExpenseOptions {
  dynamicPrompts?: string[];
  model?: string;
}

export async function parseExpense(
  text: string,
  apiKey: string,
  cache?: CacheService,
  options?: ParseExpenseOptions
): Promise<ParsedExpense> {
  const model = options?.model ?? 'deepseek/deepseek-v4.1-flash';
  const { date, time } = getCurrentColombiaTimes();
  const system = [buildSystemPrompt(date, time), ...(options?.dynamicPrompts ?? [])].join('\n\n');
  const cacheKey = cache
    ? `openrouter:${cache.hashKey(JSON.stringify({ model, system, text }))}`
    : null;

  if (cache && cacheKey) {
    const cached = await cache.get(cacheKey);
    if (cached) return JSON.parse(cached) as ParsedExpense;
  }

  const { data: expense } = await completeJson<ParsedExpense>({
    apiKey,
    model,
    system,
    user: `Input to parse: ${text}`
  });

  if (expense.is_transaction === false) return expense;
  expense.is_transaction = true;

  if (!Number.isFinite(expense.amount) || expense.amount <= 0) {
    throw new Error('Invalid amount');
  }
  if (!expense.description?.trim()) throw new Error('Missing description');
  if (!expense.category) throw new Error('Missing category');

  if (cache && cacheKey) await cache.set(cacheKey, JSON.stringify(expense), 86_400);
  return expense;
}
