import { BaseService } from './base.service';

interface AutoPostInput {
  userId: string;
  inboxItemId: string;
  accountId: string;
  categoryId: string;
  amount: string;
  date: string;
  time: string;
  cardLastFour: string;
  description: string;
  model: string;
}

export class ForwardedEmailAutoPostService extends BaseService {
  async post(input: AutoPostInput): Promise<{ status: string; transaction_id?: string }> {
    return this.fetch('/rest/v1/rpc/auto_post_verified_forwarded_purchase', {
      method: 'POST',
      body: JSON.stringify({
        p_user_id: input.userId,
        p_inbox_item_id: input.inboxItemId,
        p_account_id: input.accountId,
        p_category_id: input.categoryId,
        p_amount: input.amount,
        p_date: input.date,
        p_time: input.time,
        p_card_last_four: input.cardLastFour,
        p_description: input.description,
        p_model: input.model
      })
    });
  }
}
