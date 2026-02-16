import { createSupabaseServices } from '../services/supabase';
import { CacheService } from '../services/cache.service';
import { Env } from '../types/env';
import { CreateTransactionInput } from '../types/transaction';
import { getCurrentColombiaTimes, convertDateFormat, validateAndFixDate, validateAndFixTime } from '../utils/date';
import { isTransferMessage, processTransfer, buildTransferPromptSection, buildAutomationRulesPromptSection } from '../services/transfer-processor';

interface TransactionRequest {
  text: string;
  source?: string;
}

async function resolveUserId(request: Request, env: Env, services: ReturnType<typeof createSupabaseServices>): Promise<string | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);

  // Try per-user API key first
  const userId = await services.apiKeys.resolveUser(token);
  if (userId) return userId;

  // Fall back to legacy static API_KEY
  if (token === env.API_KEY) return env.DEFAULT_USER_ID;

  return null;
}

export async function handleTransaction(request: Request, env: Env): Promise<Response> {
  try {
    const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

    const userId = await resolveUserId(request, env, services);
    if (!userId) {
      return new Response('Unauthorized', { status: 401 });
    }

    const body = await request.json() as TransactionRequest;
    const { text, source = 'api' } = body;

    if (!text) {
      return new Response('Missing text', { status: 400 });
    }

    const { parseExpense } = await import('../parsers/gemini');
    const cache = new CacheService(env.REDIS_URL, env.REDIS_PASSWORD);

    // Fetch dynamic prompts, transfer rules, and all rules for Gemini (scoped to user)
    const [activePrompts, transferRules, allRules, accountDetectionRules] = await Promise.all([
      services.automationRules.getActivePrompts(userId),
      services.automationRules.getTransferRules(userId),
      services.automationRules.getAutomationRules(userId),
      services.automationRules.getAccountDetectionRules(userId),
    ]);

    // Pre-parse account detection: check raw text against account_detection rules
    const generalRules = allRules.filter(r => r.rule_type !== 'account_detection');
    const preMatchedAccount = accountDetectionRules.find(rule =>
      services.automationRules.matchesConditions(
        { raw_text: text } as Partial<CreateTransactionInput>,
        rule.conditions,
        rule.condition_logic ?? 'or'
      )
    );

    const accountHint = preMatchedAccount?.actions.set_account
      ? `ACCOUNT CONTEXT: This message is from account "${preMatchedAccount.name}" (id: ${preMatchedAccount.actions.set_account}).`
      : '';

    // Build dynamic prompts including transfer rules and automation rules
    const dynamicPrompts = [
      accountHint,
      ...activePrompts,
      buildTransferPromptSection(transferRules),
      buildAutomationRulesPromptSection(generalRules),
    ].filter(Boolean);

    const expense = await parseExpense(text, env.GEMINI_API_KEY, cache, { dynamicPrompts });

    // Handle non-transactional messages
    if (expense.is_transaction === false) {
      await services.skippedMessages.create({
        user_id: userId,
        raw_text: text,
        source,
        reason: expense.skip_reason ?? 'not_transaction',
        parsed_data: expense as unknown as Record<string, unknown>,
      });
      return new Response(JSON.stringify({
        status: 'skipped',
        reason: expense.skip_reason ?? 'not_transaction',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const colombiaTimes = getCurrentColombiaTimes();

    let date = colombiaTimes.date;
    let time = colombiaTimes.time;

    // Validate and fix AI-parsed dates/times
    const validatedDate = validateAndFixDate(expense.original_date);
    const validatedTime = validateAndFixTime(expense.original_time);

    if (validatedDate && validatedTime) {
      date = convertDateFormat(validatedDate);
      time = validatedTime;
    } else if (validatedDate) {
      date = convertDateFormat(validatedDate);
    }

    let accountId: string;
    const account = await services.accounts.getAccount(expense.bank, expense.last_four, expense.account_type, userId);
    if (account) {
      accountId = account.id;
    } else {
       const fallback = await services.accounts.getAccount('cash', null, null, userId) || await services.accounts.getAccount('bancolombia', null, null, userId);
       if (!fallback) throw new Error("No default account found");
       accountId = fallback.id;
    }

    let categoryId: string | undefined;
    const category = await services.categories.getCategory(expense.category, userId);
    if (category) {
      categoryId = category.id;
    }

    const transactionInput: CreateTransactionInput = {
      user_id: userId,
      date,
      time,
      amount: expense.amount,
      description: expense.description,
      category_id: categoryId,
      account_id: accountId,
      type: 'expense',
      payment_method: expense.payment_type,
      source: source,
      confidence: expense.confidence,
      raw_text: text,
      parsed_data: expense as unknown as Record<string, unknown>
    };

    // Check for duplicate transactions
    const existingExact = text
      ? await services.transactions.findExactDuplicate(text, source, userId)
      : null;
    const existingNear = existingExact
      ? null
      : await services.transactions.findNearDuplicate(
          date,
          expense.amount,
          accountId,
          userId
        );
    const duplicateMatch = existingExact ?? existingNear;

    if (duplicateMatch) {
      transactionInput.duplicate_status = 'pending_review';
      transactionInput.duplicate_of = duplicateMatch.id;
    }

    // Check if it's a transfer message
    let savedTransaction;
    let transferInfo;

    if (isTransferMessage(text) || expense.category === 'transfer') {
      // Process as transfer - may create dual transactions
      const missingCategory = await services.categories.getCategory('missing', userId);
      const result = await processTransfer(
        transactionInput,
        text,
        services,
        missingCategory?.id,
        userId
      );

      transferInfo = result.transferInfo;

      // Create all transactions (1 or 2)
      for (const tx of result.transactions) {
        const finalTx = await services.automationRules.applyAutomationRules(tx, userId);
        savedTransaction = await services.transactions.createTransaction(finalTx, services.accounts, cache);
      }
    } else {
      // Normal flow
      const finalTransaction = await services.automationRules.applyAutomationRules(transactionInput, userId);
      savedTransaction = await services.transactions.createTransaction(finalTransaction, services.accounts, cache);
    }

    return new Response(JSON.stringify({
      status: 'success',
      transaction: savedTransaction,
      transfer: transferInfo
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    console.error('Transaction API Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
