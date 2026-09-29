import type { ParsedExpense } from '../types/expense';
import type { CacheService } from '../services/cache.service';
import { completeJson } from '../ai/openrouter';
import type { AiUsageService } from '../services/supabase/ai-usage.service';
import type { AiUsageMeter } from '../ai/usage-meter';
import { buildSystemPrompt } from '../constants/parse-expens-system-prompt';
import type { PromptCategory } from '../constants/parse-expens-system-prompt';
import { getCurrentColombiaTimes } from '../utils/date';

export interface ParseExpenseOptions {
  dynamicPrompts?: string[];
  categoryCatalog?: PromptCategory[];
  model?: string;
  telemetry?: { userId: string; service: AiUsageService };
}

async function parseExpenseCore(
  text: string,
  apiKey: string,
  cache?: CacheService,
  options?: ParseExpenseOptions,
  meter?: AiUsageMeter
): Promise<ParsedExpense> {
  const model = options?.model ?? 'deepseek/deepseek-v4.1-flash';
  const { date, time } = getCurrentColombiaTimes();
  const system = [
    buildSystemPrompt(date, time, options?.categoryCatalog),
    ...(options?.dynamicPrompts ?? [])
  ].join('\n\n');
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
    user: `Input to parse: ${text}`,
    meter
  });

  if (expense.is_transaction === false) return expense;
  expense.is_transaction = true;

  if (!Number.isFinite(expense.amount) || expense.amount <= 0) {
    throw new Error('Invalid amount');
  }
  if (!expense.description?.trim()) throw new Error('Missing description');
  if (!expense.category) throw new Error('Missing category');

  if (
    options?.categoryCatalog &&
    !options.categoryCatalog.some(({ slug }) => slug === expense.category)
  ) {
    expense.category = 'missing';
  }

  if (cache && cacheKey) await cache.set(cacheKey, JSON.stringify(expense), 86_400);
  return expense;
}

export async function parseExpense(
  text: string,
  apiKey: string,
  cache?: CacheService,
  options?: ParseExpenseOptions
): Promise<ParsedExpense> {
  if (!options?.telemetry) return parseExpenseCore(text, apiKey, cache, options);
  const model = options.model ?? 'deepseek/deepseek-v4.1-flash';
  return options.telemetry.service.track(
    { userId: options.telemetry.userId, operation: 'parse_expense', model },
    (meter) => parseExpenseCore(text, apiKey, cache, options, meter)
  );
}
