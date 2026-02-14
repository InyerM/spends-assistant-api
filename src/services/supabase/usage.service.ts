import { BaseService } from './base.service';
import type { UsageTracking } from '../../types/usage';

export class UsageService extends BaseService {
  private getCurrentMonth(): string {
    return new Date().toISOString().slice(0, 7);
  }

  async getOrCreateMonthlyUsage(userId: string): Promise<UsageTracking> {
    const month = this.getCurrentMonth();
    const params = new URLSearchParams({
      user_id: `eq.${userId}`,
      month: `eq.${month}`,
    });

    const existing = await this.fetch<UsageTracking[]>(
      `/rest/v1/usage_tracking?${params.toString()}`
    );

    if (existing.length > 0) {
      return existing[0];
    }

    const created = await this.fetch<UsageTracking[]>('/rest/v1/usage_tracking', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({
        user_id: userId,
        month,
        ai_parses_used: 0,
        ai_parses_limit: 15,
        transactions_count: 0,
        transactions_limit: 50,
      }),
    });

    return created[0];
  }

  async incrementAiParses(
    userId: string
  ): Promise<{ allowed: boolean; used: number; limit: number }> {
    const usage = await this.getOrCreateMonthlyUsage(userId);

    if (usage.ai_parses_used >= usage.ai_parses_limit) {
      return {
        allowed: false,
        used: usage.ai_parses_used,
        limit: usage.ai_parses_limit,
      };
    }

    const newCount = usage.ai_parses_used + 1;
    const params = new URLSearchParams({ id: `eq.${usage.id}` });

    await this.fetch<UsageTracking[]>(
      `/rest/v1/usage_tracking?${params.toString()}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          ai_parses_used: newCount,
          updated_at: new Date().toISOString(),
        }),
      }
    );

    return {
      allowed: true,
      used: newCount,
      limit: usage.ai_parses_limit,
    };
  }

  async incrementTransactions(userId: string): Promise<void> {
    const usage = await this.getOrCreateMonthlyUsage(userId);
    const params = new URLSearchParams({ id: `eq.${usage.id}` });

    await this.fetch<UsageTracking[]>(
      `/rest/v1/usage_tracking?${params.toString()}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          transactions_count: usage.transactions_count + 1,
          updated_at: new Date().toISOString(),
        }),
      }
    );
  }

  async cleanupOldRecords(): Promise<void> {
    // Delete usage records older than 12 months
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 12);
    const cutoffMonth = cutoff.toISOString().slice(0, 7);

    const params = new URLSearchParams({ month: `lt.${cutoffMonth}` });

    await this.fetch<UsageTracking[]>(
      `/rest/v1/usage_tracking?${params.toString()}`,
      { method: 'DELETE' }
    );
  }
}
