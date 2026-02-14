import { AccountsService } from './accounts.service';
import { CategoriesService } from './categories.service';
import { TransactionsService } from './transactions.service';
import { AutomationRulesService } from './automation-rules.service';
import { ApiKeysService } from './api-keys.service';

export interface SupabaseServices {
  accounts: AccountsService;
  categories: CategoriesService;
  transactions: TransactionsService;
  automationRules: AutomationRulesService;
  apiKeys: ApiKeysService;
}

export function createSupabaseServices(
  url: string,
  serviceKey: string
): SupabaseServices {
  return {
    accounts: new AccountsService(url, serviceKey),
    categories: new CategoriesService(url, serviceKey),
    transactions: new TransactionsService(url, serviceKey),
    automationRules: new AutomationRulesService(url, serviceKey),
    apiKeys: new ApiKeysService(url, serviceKey)
  };
}

export { AccountsService } from './accounts.service';
export { CategoriesService } from './categories.service';
export { TransactionsService } from './transactions.service';
export { AutomationRulesService } from './automation-rules.service';
export { ApiKeysService } from './api-keys.service';
