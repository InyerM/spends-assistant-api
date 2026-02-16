import { BaseService } from './base.service';

export interface CreateSkippedMessageInput {
  user_id: string;
  raw_text: string;
  source?: string;
  reason?: string;
  parsed_data?: Record<string, unknown>;
}

export interface SkippedMessage {
  id: string;
  user_id: string;
  raw_text: string;
  source: string | null;
  reason: string | null;
  parsed_data: Record<string, unknown> | null;
  created_at: string;
}

export class SkippedMessagesService extends BaseService {
  async create(input: CreateSkippedMessageInput): Promise<SkippedMessage> {
    const result = await this.fetch<SkippedMessage[]>(
      '/rest/v1/skipped_messages',
      {
        method: 'POST',
        body: JSON.stringify({
          user_id: input.user_id,
          raw_text: input.raw_text,
          source: input.source ?? null,
          reason: input.reason ?? null,
          parsed_data: input.parsed_data ?? null,
        }),
      }
    );

    return result[0];
  }
}
