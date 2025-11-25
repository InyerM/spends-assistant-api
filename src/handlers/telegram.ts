import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { parseExpense } from '../parsers/gemini';
import { createSupabaseServices } from '../services/supabase';
import { CacheService } from '../services/cache.service';
import { getCurrentColombiaTimes, convertDateFormat, formatDateForDisplay } from '../utils/date';
import { formatCurrency } from '../utils/formatting';
import { Env } from '../types/env';
import { CreateTransactionInput } from '../types/transaction';

export async function handleTelegram(request: Request, env: Env): Promise<Response> {
  const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);
  const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const cache = new CacheService(env.REDIS_URL, env.REDIS_PASSWORD);

  bot.catch((err, ctx) => {
    console.error(`Telegraf error for ${ctx.updateType}`, err);
  });

  bot.on(message('text'), async (ctx: Context) => {
    // @ts-expect-error - Telegraf types might be slightly off for worker env
    const text = ctx.message?.text;
    if (!text) return;
    
    // @ts-expect-error - Telegraf types might be slightly off for worker env
    if (text.includes("Nequi") && !text.includes("85954") && !ctx.message?.forward_from) {
      // Optional stricter validation for Nequi SMS forwarding
    }

    try {
      ctx.sendChatAction('typing');
      const expense = await parseExpense(text, env.GEMINI_API_KEY, cache);

      const colombiaTimes = getCurrentColombiaTimes();
      let date = colombiaTimes.date;
      let time = colombiaTimes.time;

      if (expense.original_date && expense.original_time) {
        date = convertDateFormat(expense.original_date);
        time = expense.original_time;
      }

      let accountId: string;
      const account = await services.accounts.getAccount(expense.bank, expense.last_four);
      
      if (account) {
        accountId = account.id;
      } else {
        const cashAccount = await services.accounts.getAccount('cash');
        if (cashAccount) {
          accountId = cashAccount.id;
        } else {
          throw new Error("Could not determine account - no cash fallback found");
        }
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
        source: expense.source,
        confidence: expense.confidence,
        raw_text: text,
        parsed_data: expense as unknown as Record<string, unknown>
      };

      const finalTransaction = await services.automationRules.applyAutomationRules(transactionInput);
      const savedTransaction = await services.transactions.createTransaction(finalTransaction);

      const fechaFormateada = formatDateForDisplay(savedTransaction.date);
      const amountFormatted = formatCurrency(savedTransaction.amount);

      const confirmationMessage = `✅ Expense registered

💰 ${amountFormatted}
🏪 ${savedTransaction.description}
📅 ${fechaFormateada} ${savedTransaction.time}
🏷️ ${expense.category}
💳 ${expense.bank} - ${expense.payment_type}

🔗 [View Dashboard](${env.APP_URL || '#'})`;
      
      await ctx.reply(confirmationMessage);

    } catch (error: unknown) {
      console.error("Processing error:", error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      let replyMessage = `❌ Could not process expense\n\nTry format:\n"20000 in rappi"\n"bought 50k groceries"\n\nOr forward the SMS/email as is.\nError: ${errorMessage}`;

      if (errorMessage.includes("Rate limit")) {
        replyMessage = "⏳ Service is busy. Please try again in 30 seconds.";
      } else if (errorMessage.includes("timed out")) {
        replyMessage = "⏱️ Request timed out. Please try again.";
      } else if (errorMessage.includes("Invalid amount") || errorMessage.includes("Missing description")) {
        replyMessage = `❌ Could not understand message. Try format:\n• '20000 in rappi'\n• '50k for lunch'\n• Or forward the bank SMS`;
      }

      await ctx.reply(replyMessage);
    }
  });

  try {
    const body = await request.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await bot.handleUpdate(body as any);
    return new Response('OK');
  } catch (e) {
    console.error("Error handling update:", e);
    return new Response('Error', { status: 500 });
  }
}
