import { BaseService } from './base.service';
import type { Account } from '../../types';

export class AccountsService extends BaseService {
  async getAccount(
    institution: string,
    lastFour?: string | null,
    accountType?: 'checking' | 'savings' | 'credit_card' | 'credit' | null
  ): Promise<Account | null> {
    console.log("Querying accounts for:", { institution, lastFour, accountType });
    
    // Try with all params if provided
    if (lastFour && accountType) {
      const params = new URLSearchParams({
        institution: `eq.${institution}`,
        last_four: `eq.${lastFour}`,
        type: `eq.${accountType}`,
        is_active: 'eq.true',
        deleted_at: 'is.null',
        select: '*'
      });

      const accounts = await this.fetch<Account[]>(
        `/rest/v1/accounts?${params}`
      );

      if (accounts[0]) {
        console.log(`Found account with institution+last_four+type`);
        return accounts[0];
      }
    }

    // Try with institution + last_four (without type)
    if (lastFour) {
      const params = new URLSearchParams({
        institution: `eq.${institution}`,
        last_four: `eq.${lastFour}`,
        is_active: 'eq.true',
        deleted_at: 'is.null',
        select: '*'
      });

      const accounts = await this.fetch<Account[]>(
        `/rest/v1/accounts?${params}`
      );

      if (accounts[0]) {
        console.log(`Found account with institution+last_four`);
        return accounts[0];
      }
    }

    // Try with institution + type (without last_four)
    if (accountType) {
      const params = new URLSearchParams({
        institution: `eq.${institution}`,
        type: `eq.${accountType}`,
        is_active: 'eq.true',
        deleted_at: 'is.null',
        select: '*'
      });

      const accounts = await this.fetch<Account[]>(
        `/rest/v1/accounts?${params}`
      );

      if (accounts[0]) {
        console.log(`Found account with institution+type`);
        return accounts[0];
      }
    }

    // Fallback: search only by institution
    const params = new URLSearchParams({
      institution: `eq.${institution}`,
      is_active: 'eq.true',
      deleted_at: 'is.null',
      select: '*'
    });

    const accounts = await this.fetch<Account[]>(
      `/rest/v1/accounts?${params}`
    );

    if (accounts[0]) {
      console.log(`Found account by institution only: ${institution}`);
    }

    return accounts[0] || null;
  }

  async getAccountBalance(accountId: string): Promise<number> {
    const account = await this.fetch<Account[]>(
      `/rest/v1/accounts?id=eq.${accountId}&deleted_at=is.null&select=balance`
    );

    return account[0]?.balance || 0;
  }

  async updateBalance(
    accountId: string,
    amount: number,
    operation: 'add' | 'subtract'
  ): Promise<void> {
    const currentBalance = await this.getAccountBalance(accountId);
    const newBalance = operation === 'subtract' 
      ? currentBalance - amount 
      : currentBalance + amount;

    await this.fetch(
      `/rest/v1/accounts?id=eq.${accountId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ balance: newBalance })
      }
    );
  }
}
