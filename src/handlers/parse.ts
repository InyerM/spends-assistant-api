import { CacheService } from '../services/cache.service';
import { createSupabaseServices } from '../services/supabase';
import { Env } from '../types/env';
import { validateAndFixDate, validateAndFixTime } from '../utils/date';
import {
  buildTransferPromptSection,
  buildAutomationRulesPromptSection
} from '../services/transfer-processor';
import { resolveUserId, unauthorizedResponse } from '../utils/auth';
import { aiConsentErrorResponse } from '../utils/ai-consent-response';

interface ParseRequest {
  text: string;
}

class AiParseQuotaExceededError extends Error {
  constructor(
    readonly used: number,
    readonly limit: number
  ) {
    super('Parse limit reached');
  }
}

export async function handleParse(request: Request, env: Env): Promise<Response> {
  try {
    const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

    const userId = await resolveUserId(request, env, services.apiKeys);
    if (!userId) return unauthorizedResponse();

    const body = (await request.json()) as ParseRequest;
    const { text } = body;

    if (!text) {
      return new Response(JSON.stringify({ error: 'Missing text' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { parseExpense } = await import('../parsers/expense');
    const cache = new CacheService(env.REDIS_URL, env.REDIS_PASSWORD);

    const [activePrompts, transferRules, allRules, accountDetectionRules, categories] =
      await Promise.all([
        services.automationRules.getActivePrompts(userId),
        services.automationRules.getTransferRules(userId),
        services.automationRules.getAutomationRules(userId),
        services.automationRules.getAccountDetectionRules(userId),
        services.categories.getCategories(userId)
      ]);

    // Pre-parse account detection: check raw text against account_detection rules
    const generalRules = allRules.filter((r) => r.rule_type !== 'account_detection');
    const preMatchedAccount = services.automationRules.findUniqueAccountDetectionRule(
      accountDetectionRules,
      text
    );

    const accountHint = preMatchedAccount?.actions.set_account
      ? `ACCOUNT CONTEXT: This message is from account "${preMatchedAccount.name}" (id: ${preMatchedAccount.actions.set_account}).`
      : '';

    const dynamicPrompts = [
      accountHint,
      ...activePrompts,
      buildTransferPromptSection(transferRules),
      buildAutomationRulesPromptSection(generalRules)
    ].filter(Boolean);

    const expense = await parseExpense(text, env.OPENROUTER_API_KEY, cache, {
      dynamicPrompts,
      categoryCatalog: categories.map(({ slug, name, type }) => ({ slug, name, type })),
      model: env.OPENROUTER_TEXT_MODEL,
      telemetry: { userId, service: services.aiUsage },
      beforeExternalCall: async () => {
        const usageCheck = await services.usage.incrementAiParses(userId);
        if (!usageCheck.allowed) {
          throw new AiParseQuotaExceededError(usageCheck.used, usageCheck.limit);
        }
      }
    });

    // Handle non-transactional messages
    if (expense.is_transaction === false) {
      await services.skippedMessages.create({
        user_id: userId,
        raw_text: text,
        source: 'api',
        reason: expense.skip_reason ?? 'not_transaction',
        parsed_data: expense as unknown as Record<string, unknown>
      });
      return new Response(
        JSON.stringify({
          status: 'skipped',
          reason: expense.skip_reason ?? 'not_transaction'
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    // Validate and fix AI-parsed dates/times
    const validatedDate = validateAndFixDate(expense.original_date);
    const validatedTime = validateAndFixTime(expense.original_time);
    if (validatedDate) expense.original_date = validatedDate;
    if (validatedTime) expense.original_time = validatedTime;

    // Resolve account (scoped to user)
    let accountId: string | undefined;
    if (preMatchedAccount?.actions.set_account) {
      // Account detection rule matched — use the rule's account directly
      accountId = preMatchedAccount.actions.set_account;
      console.log(`[Account] Using account_detection rule: ${preMatchedAccount.name}`);
    } else {
      const account = await services.accounts.getAccount(
        expense.bank,
        expense.last_four,
        expense.account_type,
        userId
      );
      if (account) {
        accountId = account.id;
      } else {
        const fallback =
          (await services.accounts.getAccount('cash', null, null, userId)) ||
          (await services.accounts.getAccount('bancolombia', null, null, userId));
        if (fallback) accountId = fallback.id;
      }
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
          category_id: categoryId
        }
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  } catch (error: unknown) {
    const consentResponse = aiConsentErrorResponse(error);
    if (consentResponse) return consentResponse;
    if (error instanceof AiParseQuotaExceededError) {
      return Response.json(
        {
          error: error.message,
          code: 'PARSE_LIMIT_REACHED',
          used: error.used,
          limit: error.limit
        },
        { status: 429 }
      );
    }
    console.error('Parse API Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
