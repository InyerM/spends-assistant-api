import { BaseService } from './base.service';
import type {
  InboxAnalysisItem,
  InboxAnalysisJob,
  InboxAnalysisLease,
  InboxAnalysisProposal,
  InboxAnalysisResult,
  InboxAnalysisState
} from '../../types/inbox-analysis';

export class InboxAnalysisService extends BaseService {
  async item(userId: string, id: string): Promise<InboxAnalysisItem | null> {
    const params = new URLSearchParams({
      select: 'id,user_id,source,status,raw_text,received_at,message_kind',
      user_id: `eq.${userId}`,
      id: `eq.${id}`,
      limit: '1'
    });
    const rows = await this.fetch<InboxAnalysisItem[]>(`/rest/v1/shortcut_inbox_items?${params}`);
    return rows.find((row) => row.id === id && row.user_id === userId) ?? null;
  }

  async analysis(userId: string, id: string): Promise<InboxAnalysisResult | null> {
    const params = new URLSearchParams({
      select: '*',
      user_id: `eq.${userId}`,
      inbox_item_id: `eq.${id}`,
      limit: '1'
    });
    const rows = await this.fetch<InboxAnalysisResult[]>(
      `/rest/v1/forwarded_email_analyses?${params}`
    );
    return rows.find((row) => row.inbox_item_id === id && row.user_id === userId) ?? null;
  }

  async job(userId: string, id: string): Promise<InboxAnalysisJob | null> {
    const params = new URLSearchParams({
      select: 'inbox_item_id,user_id,state,attempts,last_error,available_at',
      user_id: `eq.${userId}`,
      inbox_item_id: `eq.${id}`,
      limit: '1'
    });
    const rows = await this.fetch<InboxAnalysisJob[]>(`/rest/v1/inbox_analysis_jobs?${params}`);
    return rows.find((row) => row.inbox_item_id === id && row.user_id === userId) ?? null;
  }

  async request(userId: string, id: string, force = false): Promise<InboxAnalysisState> {
    return this.fetch<InboxAnalysisState>('/rest/v1/rpc/request_inbox_analysis_job', {
      method: 'POST',
      body: JSON.stringify({ p_inbox_item_id: id, p_user_id: userId, p_force: force })
    });
  }

  async claim(limit: number, id?: string, userId?: string): Promise<InboxAnalysisLease[]> {
    const rows = await this.fetch<InboxAnalysisLease[]>('/rest/v1/rpc/claim_inbox_analysis_jobs', {
      method: 'POST',
      body: JSON.stringify({
        p_limit: limit,
        p_inbox_item_id: id ?? null,
        p_user_id: userId ?? null
      })
    });
    if (
      !Array.isArray(rows) ||
      rows.some(
        (row) =>
          !row ||
          typeof row.inbox_item_id !== 'string' ||
          typeof row.user_id !== 'string' ||
          typeof row.lease_token !== 'string' ||
          (id && row.inbox_item_id !== id) ||
          (userId && row.user_id !== userId)
      )
    )
      throw new Error('Invalid inbox analysis lease');
    return rows;
  }

  async complete(lease: InboxAnalysisLease, proposal: InboxAnalysisProposal): Promise<boolean> {
    return this.fetch<boolean>('/rest/v1/rpc/complete_inbox_analysis_job', {
      method: 'POST',
      body: JSON.stringify({
        p_inbox_item_id: lease.inbox_item_id,
        p_user_id: lease.user_id,
        p_lease_token: lease.lease_token,
        p_analysis: proposal
      })
    });
  }

  async fail(lease: InboxAnalysisLease, reason: string, blocked: boolean): Promise<boolean> {
    return this.fetch<boolean>('/rest/v1/rpc/fail_inbox_analysis_job', {
      method: 'POST',
      body: JSON.stringify({
        p_inbox_item_id: lease.inbox_item_id,
        p_user_id: lease.user_id,
        p_lease_token: lease.lease_token,
        p_reason: reason,
        p_retry_seconds: 60,
        p_blocked: blocked
      })
    });
  }

  async due(
    limit = 20,
    userId?: string,
    ids?: string[]
  ): Promise<Array<{ inbox_item_id: string }>> {
    const now = new Date().toISOString();
    const params = new URLSearchParams({
      select: 'inbox_item_id',
      or: `(and(state.in.(pending,failed),attempts.lt.3,available_at.lte.${now}),and(state.eq.running,leased_until.lte.${now}))`,
      order: 'available_at.asc',
      limit: String(Math.min(20, Math.max(1, limit))),
      ...(userId ? { user_id: `eq.${userId}` } : {}),
      ...(ids?.length ? { inbox_item_id: `in.(${ids.join(',')})` } : {})
    });
    return this.fetch<Array<{ inbox_item_id: string }>>(`/rest/v1/inbox_analysis_jobs?${params}`);
  }
}
