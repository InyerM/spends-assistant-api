import { describe, expect, it, vi } from 'vitest';
import { ForwardedEmailAutoPostService } from '../../../src/services/supabase/forwarded-email-auto-post.service';

describe('forwarded email auto post service', () => {
  it('sends an owner-scoped reviewed purchase to the atomic RPC', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ status: 'created', transaction_id: 'tx-id' }))
    );
    const service = new ForwardedEmailAutoPostService('https://db.test', 'service-key');
    const input = {
      userId: 'owner-id',
      inboxItemId: 'inbox-id',
      accountId: 'account-id',
      categoryId: 'category-id',
      amount: '188165.52',
      date: '2026-10-05',
      time: '12:24:00',
      cardLastFour: '8456',
      description: 'Compra en SHEIN.COM',
      model: 'model'
    };
    expect(await service.post(input)).toMatchObject({ status: 'created' });
    expect(fetch).toHaveBeenCalledWith(
      'https://db.test/rest/v1/rpc/auto_post_verified_forwarded_purchase',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          p_user_id: 'owner-id',
          p_inbox_item_id: 'inbox-id',
          p_account_id: 'account-id',
          p_category_id: 'category-id',
          p_amount: '188165.52',
          p_date: '2026-10-05',
          p_time: '12:24:00',
          p_card_last_four: '8456',
          p_description: 'Compra en SHEIN.COM',
          p_model: 'model'
        })
      })
    );
  });
});
