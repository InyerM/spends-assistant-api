import { CacheService } from '../services/cache.service';
import { createSupabaseServices } from '../services/supabase';
import { Env } from '../types/env';
import { buildTransferPromptSection, buildAutomationRulesPromptSection } from '../services/transfer-processor';

interface ParseRequest {
  text: string;
}

export async function handleParse(request: Request, env: Env): Promise<Response> {
  try {
    const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

    // Resolve user from API key
    const authHeader = request.headers.get('Authorization');
    console.log('Auth header:', authHeader);
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response('Unauthorized', { status: 401 });
    }

    const token = authHeader.slice(7);
    let userId = await services.apiKeys.resolveUser(token);

    // Fall back to legacy static API_KEY
    if (!userId && token === env.API_KEY) {
      userId = env.DEFAULT_USER_ID;
    }

    // Fall back to Supabase JWT verification
    if (!userId) {
      try {
        const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
          headers: {
            Authorization: `Bearer ${token}`,
            apikey: env.SUPABASE_SERVICE_KEY,
          },
        });
        if (userRes.ok) {
          const user = (await userRes.json()) as { id: string };
          userId = user.id;
        }
      } catch {
        // JWT verification failed, userId remains null
      }
    }

    if (!userId) {
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

    // Check AI parse usage limit
    const usageCheck = await services.usage.incrementAiParses(userId);
    if (!usageCheck.allowed) {
      return new Response(
        JSON.stringify({
          error: 'Parse limit reached',
          code: 'PARSE_LIMIT_REACHED',
          used: usageCheck.used,
          limit: usageCheck.limit,
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const { parseExpense } = await import('../parsers/gemini');
    const cache = new CacheService(env.REDIS_URL, env.REDIS_PASSWORD);

    const [activePrompts, transferRules, allRules] = await Promise.all([
      services.automationRules.getActivePrompts(userId),
      services.automationRules.getTransferRules(userId),
      services.automationRules.getAutomationRules(userId),
    ]);

    const dynamicPrompts = [
      ...activePrompts,
      buildTransferPromptSection(transferRules),
      buildAutomationRulesPromptSection(allRules),
    ].filter(Boolean);

    const expense = await parseExpense(text, env.GEMINI_API_KEY, cache, { dynamicPrompts });

    // Resolve account (scoped to user)
    let accountId: string | undefined;
    const account = await services.accounts.getAccount(
      expense.bank,
      expense.last_four,
      expense.account_type,
      userId,
    );
    if (account) {
      accountId = account.id;
    } else {
      const fallback =
        (await services.accounts.getAccount('cash', null, null, userId)) ||
        (await services.accounts.getAccount('bancolombia', null, null, userId));
      if (fallback) accountId = fallback.id;
    }

    // Resolve category (scoped to user)
    let categoryId: string | undefined;
    const category = await services.categories.getCategory(expense.category, userId);
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
