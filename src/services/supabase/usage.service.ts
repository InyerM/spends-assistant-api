import { BaseService } from './base.service';
import type { UsageTracking } from '../../types/usage';

interface Subscription {
  plan: 'free' | 'pro';
  status: 'active' | 'canceled' | 'past_due';
}

interface AppSetting {
  key: string;
  value: number;
}

const DEFAULT_AI_PARSES_LIMIT = 15;
const DEFAULT_TRANSACTIONS_LIMIT = 50;

export class UsageService extends BaseService {
  private getCurrentMonth(): string {
    return new Date().toISOString().slice(0, 7);
  }

  private async isProUser(userId: string): Promise<boolean> {
    const params = new URLSearchParams({
      user_id: `eq.${userId}`,
      plan: 'eq.pro',
      status: 'eq.active',
    });

    const results = await this.fetch<Subscription[]>(
      `/rest/v1/subscriptions?${params.toString()}&select=plan,status`
    );

    return results.length > 0;
  }

  private async getAppSettingValue(key: string, fallback: number): Promise<number> {
    const params = new URLSearchParams({ key: `eq.${key}`, select: 'key,value' });

    const results = await this.fetch<AppSetting[]>(
      `/rest/v1/app_settings?${params.toString()}`
    );

    return results.length > 0 ? Number(results[0].value) : fallback;
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

    const [aiLimit, txLimit] = await Promise.all([
      this.getAppSettingValue('free_ai_parses_limit', DEFAULT_AI_PARSES_LIMIT),
      this.getAppSettingValue('free_transactions_limit', DEFAULT_TRANSACTIONS_LIMIT),
    ]);

    const created = await this.fetch<UsageTracking[]>('/rest/v1/usage_tracking', {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({
        user_id: userId,
        month,
        ai_parses_used: 0,
        ai_parses_limit: aiLimit,
        transactions_count: 0,
        transactions_limit: txLimit,
      }),
    });

    return created[0];
  }

  async incrementAiParses(
    userId: string
  ): Promise<{ allowed: boolean; used: number; limit: number }> {
    const [usage, isPro] = await Promise.all([
      this.getOrCreateMonthlyUsage(userId),
      this.isProUser(userId),
    ]);

    // Pro users have unlimited AI parses
    if (isPro) {
      const newCount = usage.ai_parses_used + 1;
      const patchParams = new URLSearchParams({ id: `eq.${usage.id}` });

      await this.fetch<UsageTracking[]>(
        `/rest/v1/usage_tracking?${patchParams.toString()}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            ai_parses_used: newCount,
            updated_at: new Date().toISOString(),
          }),
        }
      );

      return { allowed: true, used: newCount, limit: -1 };
    }

    // Free users: check against dynamic limit from app_settings
    const dynamicLimit = await this.getAppSettingValue(
      'free_ai_parses_limit',
      DEFAULT_AI_PARSES_LIMIT
    );

    if (usage.ai_parses_used >= dynamicLimit) {
      return {
        allowed: false,
        used: usage.ai_parses_used,
        limit: dynamicLimit,
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
      limit: dynamicLimit,
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
