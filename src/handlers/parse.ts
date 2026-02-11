import { CacheService } from '../services/cache.service';
import { createSupabaseServices } from '../services/supabase';
import { Env } from '../types/env';
import { buildTransferPromptSection, buildAutomationRulesPromptSection } from '../services/transfer-processor';

interface ParseRequest {
  text: string;
}

export async function handleParse(request: Request, env: Env): Promise<Response> {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || authHeader !== `Bearer ${env.API_KEY}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    const body = (await request.json()) as ParseRequest;
    const { text } = body;

    if (!text) {
      return new Response(JSON.stringify({ error: 'Missing text' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { parseExpense } = await import('../parsers/gemini');
    const cache = new CacheService(env.REDIS_URL, env.REDIS_PASSWORD);
    const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

    const [activePrompts, transferRules, allRules] = await Promise.all([
      services.automationRules.getActivePrompts(),
      services.automationRules.getTransferRules(),
      services.automationRules.getAutomationRules(),
    ]);

    const dynamicPrompts = [
      ...activePrompts,
      buildTransferPromptSection(transferRules),
      buildAutomationRulesPromptSection(allRules),
    ].filter(Boolean);

    const expense = await parseExpense(text, env.GEMINI_API_KEY, cache, { dynamicPrompts });

    // Resolve account
    let accountId: string | undefined;
    const account = await services.accounts.getAccount(
      expense.bank,
      expense.last_four,
      expense.account_type,
    );
    if (account) {
      accountId = account.id;
    } else {
      const fallback =
        (await services.accounts.getAccount('cash')) ||
        (await services.accounts.getAccount('bancolombia'));
      if (fallback) accountId = fallback.id;
    }

    // Resolve category
    let categoryId: string | undefined;
    const category = await services.categories.getCategory(expense.category);
    if (category) {
      categoryId = category.id;
    }

    return new Response(
      JSON.stringify({
        parsed: expense,
        resolved: {
          account_id: accountId,
          category_id: categoryId,
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  } catch (error: unknown) {
    console.error('Parse API Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
