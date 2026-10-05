import { AccountsService } from './accounts.service';
import { CategoriesService } from './categories.service';
import { TransactionsService } from './transactions.service';
import { AutomationRulesService } from './automation-rules.service';
import { ApiKeysService } from './api-keys.service';
import { UsageService } from './usage.service';
import { AiUsageService } from './ai-usage.service';
import { SkippedMessagesService } from './skipped-messages.service';
import { ShortcutInboxService } from './shortcut-inbox.service';
import { EmailForwardingRoutesService } from './email-forwarding-routes.service';
import { ForwardedEmailAutoPostService } from './forwarded-email-auto-post.service';

export interface SupabaseServices {
  accounts: AccountsService;
  categories: CategoriesService;
  transactions: TransactionsService;
  automationRules: AutomationRulesService;
  apiKeys: ApiKeysService;
  usage: UsageService;
  aiUsage: AiUsageService;
  skippedMessages: SkippedMessagesService;
  shortcutInbox: ShortcutInboxService;
  forwardingRoutes: EmailForwardingRoutesService;
  forwardedEmailAutoPost: ForwardedEmailAutoPostService;
}

export function createSupabaseServices(url: string, serviceKey: string): SupabaseServices {
  return {
    accounts: new AccountsService(url, serviceKey),
    categories: new CategoriesService(url, serviceKey),
    transactions: new TransactionsService(url, serviceKey),
    automationRules: new AutomationRulesService(url, serviceKey),
    apiKeys: new ApiKeysService(url, serviceKey),
    usage: new UsageService(url, serviceKey),
    aiUsage: new AiUsageService(url, serviceKey),
    skippedMessages: new SkippedMessagesService(url, serviceKey),
    shortcutInbox: new ShortcutInboxService(url, serviceKey),
    forwardingRoutes: new EmailForwardingRoutesService(url, serviceKey),
    forwardedEmailAutoPost: new ForwardedEmailAutoPostService(url, serviceKey)
  };
}

export { AccountsService } from './accounts.service';
export { CategoriesService } from './categories.service';
export { TransactionsService } from './transactions.service';
export { AutomationRulesService } from './automation-rules.service';
export { ApiKeysService } from './api-keys.service';
export { UsageService } from './usage.service';
export { AiUsageService } from './ai-usage.service';
export { SkippedMessagesService } from './skipped-messages.service';
export { ShortcutInboxService } from './shortcut-inbox.service';
export { EmailForwardingRoutesService } from './email-forwarding-routes.service';
export { ForwardedEmailAutoPostService } from './forwarded-email-auto-post.service';
