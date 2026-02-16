import { parseExpense } from '../parsers/gemini';
import { createSupabaseServices } from '../services/supabase';
import { CacheService } from '../services/cache.service';
import { getCurrentColombiaTimes, convertDateFormat, validateAndFixDate, validateAndFixTime } from '../utils/date';
import { Env } from '../types/env';
import { CreateTransactionInput } from '../types/transaction';
import { isTransferMessage, processTransfer, buildTransferPromptSection, buildAutomationRulesPromptSection } from '../services/transfer-processor';

interface AppsScriptPayload {
  body?: string;
  text?: string;
  subject?: string;
}

export async function handleEmail(request: Request, env: Env): Promise<Response> {
  try {
    const contentType = request.headers.get('content-type') || '';
    const userId = env.DEFAULT_USER_ID;

    let emailData: AppsScriptPayload;

    if (contentType.includes('application/json')) {
      emailData = await request.json() as AppsScriptPayload;
      console.log('[Email] Received from Apps Script:', emailData);

      const emailText = emailData.body || emailData.text || emailData.subject || '';

      if (!emailText.toLowerCase().includes('bancolombia')) {
        console.log('[Email] Not Bancolombia, ignoring');
        return new Response(JSON.stringify({ status: 'ignored', reason: 'not_bancolombia' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const cleanText = extractBancolombiaText(emailText);

      if (!cleanText) {
        console.log('[Email] Could not extract valid text');
        return new Response(JSON.stringify({ status: 'error', reason: 'no_text_extracted' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      console.log('[Email] Clean text:', cleanText);

      const cache = new CacheService(env.REDIS_URL, env.REDIS_PASSWORD);
      const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

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
          { raw_text: cleanText } as Partial<CreateTransactionInput>,
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

      const expense = await parseExpense(cleanText, env.GEMINI_API_KEY, cache, { dynamicPrompts });

      // Handle non-transactional messages
      if (expense.is_transaction === false) {
        await services.skippedMessages.create({
          user_id: userId,
          raw_text: cleanText,
          source: 'bancolombia_email',
          reason: expense.skip_reason ?? 'not_transaction',
          parsed_data: expense as unknown as Record<string, unknown>,
        });
        console.log('[Email] Non-transactional message skipped:', expense.skip_reason);
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
      const account = await services.accounts.getAccount('bancolombia', expense.last_four, expense.account_type, userId);
      if (account) {
        accountId = account.id;
      } else {
        throw new Error(`Bancolombia account not found${expense.last_four ? ` with card ending in ${expense.last_four}` : ''}`);
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
        source: 'bancolombia_email',
        confidence: expense.confidence,
        raw_text: cleanText,
        parsed_data: expense as unknown as Record<string, unknown>
      };

      // Check if it's a transfer message
      let isInternalTransfer = false;

      if (isTransferMessage(cleanText) || expense.category === 'transfer') {
        // Process as transfer - may create dual transactions
        const missingCategory = await services.categories.getCategory('missing', userId);
        const result = await processTransfer(
          transactionInput,
          cleanText,
          services,
          missingCategory?.id,
          userId
        );

        isInternalTransfer = result.transferInfo.isInternalTransfer;

        // Create all transactions (1 or 2)
        for (const tx of result.transactions) {
          const finalTx = await services.automationRules.applyAutomationRules(tx, userId);
          await services.transactions.createTransaction(finalTx, services.accounts, cache);
        }

        if (isInternalTransfer) {
          console.log(`[Email] Internal transfer created: ${result.transferInfo.ruleName}`);
        }
      } else {
        // Normal flow
        const finalTransaction = await services.automationRules.applyAutomationRules(transactionInput, userId);
        await services.transactions.createTransaction(finalTransaction, services.accounts, cache);
      }

      console.log('[Email] Processed successfully');

      return new Response(JSON.stringify({
        status: 'success',
        expense: {
          amount: expense.amount,
          description: expense.description,
          category: expense.category
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ status: 'error', reason: 'invalid_format' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    console.error('[Email] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({
      status: 'error',
      message: errorMessage
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

function extractBancolombiaText(emailBody: string): string | null {
  const patterns = [
    /Bancolombia:.*?(?:\$|COP)?[\d,.]+.*?en.*?/i,
    /Compraste.*?(?:\$|COP)?[\d,.]+.*?en.*?con tu/i,
    /Retiraste.*?(?:\$|COP)?[\d,.]+.*?en/i,
    /Pagaste.*?(?:\$|COP)?[\d,.]+.*?en/i
  ];

  for (const pattern of patterns) {
    const match = emailBody.match(pattern);
    if (match) {
      const text = match[0];
      const startIdx = emailBody.indexOf(text);
      const extended = emailBody.substring(startIdx, startIdx + 200);
      return extended.split('\n')[0];
    }
  }

  const lines = emailBody.split('\n');
  for (const line of lines) {
    if (line.toLowerCase().includes('bancolombia') && /[\d,.]+/.test(line)) {
      return line.trim();
    }
  }

  return null;
}
