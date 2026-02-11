import type { CreateTransactionInput, AutomationRule } from '../types';
import type { createSupabaseServices } from './supabase';

export interface TransferInfo {
  destinationPhone: string | null;
  fromAccountLastFour: string | null;
  isInternalTransfer: boolean;
  linkedAccountId?: string;
  ruleName?: string;
}

export interface TransferProcessResult {
  transactions: CreateTransactionInput[];
  transferInfo: TransferInfo;
}

/**
 * Extract phone number from transfer message
 * Handles formats like:
 * - *3104633357
 * - 3104633357
 * - la cuenta *3104633357
 */
export function extractPhoneNumber(rawText: string): string | null {
  // Pattern for Colombian phone numbers (10 digits, optionally prefixed with *)
  // Matches: *3104633357, 3104633357, cuenta *3104633357
  const patterns = [
    /\*(\d{10})\b/,           // *3104633357
    /cuenta\s*\*?(\d{10})\b/i, // cuenta *3104633357 or cuenta 3104633357
    /a\s+(\d{10})\b/,         // a 3104633357
    /al?\s+\*?(\d{10})\b/i,   // al *3104633357
  ];

  for (const pattern of patterns) {
    const match = rawText.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * Extract origin account last 4 digits from transfer message
 * Handles formats like: "desde tu cuenta 2651"
 */
export function extractOriginAccount(rawText: string): string | null {
  const patterns = [
    /desde\s+tu\s+cuenta\s+(\d{4})\b/i,
    /cuenta\s+(\d{4})\s+a\s+la/i,
    /\*(\d{4})\s*,?\s*el\s+\d/i,
  ];

  for (const pattern of patterns) {
    const match = rawText.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

/**
 * Check if the message is a transfer message
 */
export function isTransferMessage(rawText: string): boolean {
  const transferKeywords = [
    'transferiste',
    'enviaste',
    'transferencia',
    'envío a',
    'envio a',
    'transfer to',
    'sent to',
  ];

  const lowerText = rawText.toLowerCase();
  return transferKeywords.some(keyword => lowerText.includes(keyword));
}

/**
 * Process a transfer transaction
 * Returns 1 or 2 transactions depending on whether it's an internal transfer
 */
export async function processTransfer(
  transaction: CreateTransactionInput,
  rawText: string,
  services: ReturnType<typeof createSupabaseServices>,
  categoryId?: string
): Promise<TransferProcessResult> {
  // 1. Extract phone from message
  const phone = extractPhoneNumber(rawText);
  const originAccount = extractOriginAccount(rawText);

  const transferInfo: TransferInfo = {
    destinationPhone: phone,
    fromAccountLastFour: originAccount,
    isInternalTransfer: false,
  };

  // 2. If no phone found, return as missing category
  if (!phone) {
    console.log('[Transfer] No phone number found in message');
    return {
      transactions: [{
        ...transaction,
        category_id: categoryId,
        type: 'expense',
        notes: transaction.notes 
          ? `${transaction.notes}\nTransfer - no matching phone found`
          : 'Transfer - no matching phone found',
      }],
      transferInfo,
    };
  }

  // 3. Check automation rules for matching phone
  const rule = await services.automationRules.findTransferRule(phone);

  if (!rule) {
    // No rule match → category: missing (or keep original)
    console.log(`[Transfer] No rule found for phone: ${phone}`);
    return {
      transactions: [{
        ...transaction,
        category_id: categoryId,
        type: 'expense',
        notes: transaction.notes 
          ? `${transaction.notes}\nTransfer to ${phone} - no matching rule`
          : `Transfer to ${phone} - no matching rule`,
      }],
      transferInfo: {
        ...transferInfo,
        isInternalTransfer: false,
      },
    };
  }

  // 4. Internal transfer detected - create dual transactions
  console.log(`[Transfer] Rule matched: ${rule.name} for phone: ${phone}`);
  
  transferInfo.isInternalTransfer = true;
  transferInfo.linkedAccountId = rule.transfer_to_account_id || undefined;
  transferInfo.ruleName = rule.name;

  const transferId = crypto.randomUUID();

  // Get transfer category
  const transferCategory = await services.categories.getCategory('transfer');
  const transferCategoryId = transferCategory?.id || categoryId;

  // Outgoing transaction (from source account)
  const outgoing: CreateTransactionInput = {
    ...transaction,
    category_id: transferCategoryId,
    type: 'transfer',
    transfer_to_account_id: rule.transfer_to_account_id || undefined,
    transfer_id: transferId,
    description: `Transfer to ${rule.name}`,
    notes: transaction.notes 
      ? `${transaction.notes}\nInternal transfer to ${phone}`
      : `Internal transfer to ${phone}`,
  };

  // Incoming transaction (to destination account)
  const incoming: CreateTransactionInput = {
    ...transaction,
    account_id: rule.transfer_to_account_id!,
    type: 'transfer',
    category_id: transferCategoryId,
    transfer_id: transferId,
    description: `Transfer from ${transaction.description || 'Bancolombia'}`,
    notes: `Internal transfer from account ending in ${originAccount || 'unknown'}`,
  };

  return {
    transactions: [outgoing, incoming],
    transferInfo,
  };
}

/**
 * Build dynamic prompt section for transfer rules (kept minimal to avoid token limits)
 */
export function buildTransferPromptSection(rules: AutomationRule[]): string {
  if (rules.length === 0) {
    return '';
  }

  const ruleLines = rules
    .filter(r => r.match_phone)
    .map(r => `*${r.match_phone}→transfer`)
    .join(', ');

  if (!ruleLines) {
    return '';
  }

  return `TRANSFERS: Messages with "Transferiste"/"Enviaste" are transfers. Known phones: ${ruleLines}. Unknown phones→category:"missing".`;
}

/**
 * Build dynamic prompt section from automation rules' conditions/actions.
 * This allows Gemini to proactively apply known rules during parsing.
 */
export function buildAutomationRulesPromptSection(rules: AutomationRule[]): string {
  const actionRules = rules.filter(
    r => r.conditions && r.actions &&
    (r.actions.set_type || r.actions.set_category || r.actions.link_to_account) &&
    !r.match_phone
  );

  if (actionRules.length === 0) return '';

  const lines = actionRules.map(r => {
    const condParts: string[] = [];
    if (r.conditions.description_contains?.length) {
      condParts.push(`description contains [${r.conditions.description_contains.join(', ')}]`);
    }
    if (r.conditions.description_regex) {
      condParts.push(`description matches /${r.conditions.description_regex}/`);
    }
    if (r.conditions.amount_between) {
      condParts.push(`amount between ${r.conditions.amount_between[0]}-${r.conditions.amount_between[1]}`);
    }
    if (r.conditions.source?.length) {
      condParts.push(`source is [${r.conditions.source.join(', ')}]`);
    }

    const actParts: string[] = [];
    if (r.actions.set_type) actParts.push(`type→"${r.actions.set_type}"`);
    if (r.actions.set_category) actParts.push(`category→"${r.actions.set_category}"`);

    if (condParts.length === 0 || actParts.length === 0) return '';
    return `- RULE "${r.name}": IF ${condParts.join(' AND ')} THEN ${actParts.join(', ')}`;
  }).filter(Boolean);

  if (lines.length === 0) return '';

  console.log('[Transfer] Automation rules prompt section built:', JSON.stringify(lines, null, 2));

  return `AUTOMATION RULES (apply these when conditions match, they override default categorization):
${lines.join('\n')}
If a rule matches, use the specified values. These rules are deterministic overrides from the user.`;
}
