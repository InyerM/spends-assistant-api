import { createSupabaseServices } from '../services/supabase';
import { CacheService } from '../services/cache.service';
import { Env } from '../types/env';
import { CreateTransactionInput } from '../types/transaction';
import { getCurrentColombiaTimes, convertDateFormat } from '../utils/date';
import { isTransferMessage, processTransfer, buildTransferPromptSection, buildAutomationRulesPromptSection } from '../services/transfer-processor';

interface TransactionRequest {
  text: string;
  source?: string;
}

export async function handleTransaction(request: Request, env: Env): Promise<Response> {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || authHeader !== `Bearer ${env.API_KEY}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    const body = await request.json() as TransactionRequest;
    const { text, source = 'api' } = body;

    if (!text) {
      return new Response('Missing text', { status: 400 });
    }

    const { parseExpense } = await import('../parsers/gemini');
    const cache = new CacheService(env.REDIS_URL, env.REDIS_PASSWORD);
    const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
    
    // Fetch dynamic prompts, transfer rules, and all rules for Gemini
    const [activePrompts, transferRules, allRules] = await Promise.all([
      services.automationRules.getActivePrompts(),
      services.automationRules.getTransferRules(),
      services.automationRules.getAutomationRules(),
    ]);

    // Build dynamic prompts including transfer rules and automation rules
    const dynamicPrompts = [
      ...activePrompts,
      buildTransferPromptSection(transferRules),
      buildAutomationRulesPromptSection(allRules),
    ].filter(Boolean);
    
    const expense = await parseExpense(text, env.GEMINI_API_KEY, cache, { dynamicPrompts });
    const colombiaTimes = getCurrentColombiaTimes();

    let date = colombiaTimes.date;
    let time = colombiaTimes.time;

    if (expense.original_date && expense.original_time) {
      date = convertDateFormat(expense.original_date);
      time = expense.original_time;
    }

    let accountId: string;
    const account = await services.accounts.getAccount(expense.bank, expense.last_four, expense.account_type);
    if (account) {
      accountId = account.id;
    } else {
       const fallback = await services.accounts.getAccount('cash') || await services.accounts.getAccount('bancolombia');
       if (!fallback) throw new Error("No default account found");
       accountId = fallback.id;
    }

    let categoryId: string | undefined;
    const category = await services.categories.getCategory(expense.category);
    if (category) {
      categoryId = category.id;
    }

    const transactionInput: CreateTransactionInput = {
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
      ? await services.transactions.findExactDuplicate(text, source)
      : null;
    const existingNear = existingExact
      ? null
      : await services.transactions.findNearDuplicate(
          date,
          expense.amount,
          accountId
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
      const missingCategory = await services.categories.getCategory('missing');
      const result = await processTransfer(
        transactionInput,
        text,
        services,
        missingCategory?.id
      );

      transferInfo = result.transferInfo;

      // Create all transactions (1 or 2)
      for (const tx of result.transactions) {
        const finalTx = await services.automationRules.applyAutomationRules(tx);
        savedTransaction = await services.transactions.createTransaction(finalTx, services.accounts, cache);
      }
    } else {
      // Normal flow
      const finalTransaction = await services.automationRules.applyAutomationRules(transactionInput);
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
