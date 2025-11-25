import { BaseService } from './base.service';
import { CacheService } from '../cache.service';
import type { Transaction, CreateTransactionInput } from '../../types';
import type { AccountsService } from './accounts.service';

export class TransactionsService extends BaseService {
  async createTransaction(
    data: CreateTransactionInput,
    accountsService: AccountsService,
    cache?: CacheService
  ): Promise<Transaction> {
    const transactions = await this.fetch<Transaction[]>(
      '/rest/v1/transactions',
      {
        method: 'POST',
        body: JSON.stringify(data)
      }
    );

    const transaction = transactions[0];

    // Update account balances
    if (data.type === 'expense') {
      await accountsService.updateBalance(data.account_id, data.amount, 'subtract');
    } else if (data.type === 'income') {
      await accountsService.updateBalance(data.account_id, data.amount, 'add');
    } else if (data.type === 'transfer' && data.transfer_to_account_id) {
      await accountsService.updateBalance(data.account_id, data.amount, 'subtract');
      await accountsService.updateBalance(data.transfer_to_account_id, data.amount, 'add');
    }

    // Invalidate cache
    if (cache) {
      await cache.del(`balance:${data.account_id}`);
      if (data.transfer_to_account_id) {
        await cache.del(`balance:${data.transfer_to_account_id}`);
      }
    }

    return transaction;
  }

  async findSimilarTransaction(
    date: string,
    amount: number,
    description: string,
    accountId: string
  ): Promise<Transaction | null> {
    const descriptionQuery = description.substring(0, 20);

    const transactions = await this.fetch<Transaction[]>(
      `/rest/v1/transactions?` +
      `date=eq.${date}&` +
      `amount=eq.${amount}&` +
      `account_id=eq.${accountId}&` +
      `description=ilike.%${encodeURIComponent(descriptionQuery)}%&` +
      `select=*`
    );

    return transactions.length > 0 ? transactions[0] : null;
  }
}
