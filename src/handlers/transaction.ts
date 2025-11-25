import { createSupabaseServices } from '../services/supabase';
import { CacheService } from '../services/cache.service';
import { Env } from '../types/env';
import { CreateTransactionInput } from '../types/transaction';
import { getCurrentColombiaTimes } from '../utils/date';

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
    const expense = await parseExpense(text, env.GEMINI_API_KEY, cache);
    
    const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
    const colombiaTimes = getCurrentColombiaTimes();
    
    let accountId: string;
    const account = await services.accounts.getAccount(expense.bank, expense.last_four);
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
      date: colombiaTimes.date,
      time: colombiaTimes.time,
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

    const finalTransaction = await services.automationRules.applyAutomationRules(transactionInput);
    const savedTransaction = await services.transactions.createTransaction(finalTransaction);

    return new Response(JSON.stringify({
      status: 'success',
      transaction: savedTransaction
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
