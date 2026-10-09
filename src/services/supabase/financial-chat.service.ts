import { BaseService } from './base.service';

interface SourceRow {
  id: string;
  [key: string]: unknown;
}
export interface FinancialChatSnapshot {
  transactions: SourceRow[];
  accounts: SourceRow[];
  documents: SourceRow[];
}

/** Fixed read tools; no model-controlled SQL, field lists, or write operations. */
export class FinancialChatService extends BaseService {
  async saveAnswer(
    userId: string,
    entry: {
      month: string;
      question: string;
      answer: string;
      insufficientContext: boolean;
      citationIds: string[];
    }
  ): Promise<string> {
    const rows = await this.fetch<Array<{ id: string }>>('/rest/v1/financial_chat_history', {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId,
        month: entry.month,
        question: entry.question,
        answer: entry.answer,
        insufficient_context: entry.insufficientContext,
        citation_ids: entry.citationIds
      })
    });
    if (!rows[0]?.id) throw new Error('Chat history was not saved');
    return rows[0].id;
  }

  async snapshot(userId: string, month: string): Promise<FinancialChatSnapshot> {
    const [year, monthNumber] = month.split('-').map(Number);
    const nextMonth = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);
    const owner = { user_id: `eq.${userId}` };
    const transactions = new URLSearchParams({
      ...owner,
      select: 'id,date,amount,currency,type,description,account_id,category_id',
      and: `(date.gte.${month}-01,date.lt.${nextMonth})`,
      deleted_at: 'is.null',
      duplicate_status: 'is.null',
      order: 'date.desc,id',
      limit: '101'
    });
    const accounts = new URLSearchParams({
      ...owner,
      select: 'id,name,type,currency,balance',
      is_active: 'eq.true',
      deleted_at: 'is.null',
      order: 'id',
      limit: '51'
    });
    const documents = new URLSearchParams({
      ...owner,
      select: 'id,document_type,status,created_at',
      status: 'eq.extracted',
      archived_at: 'is.null',
      and: `(created_at.gte.${month}-01,created_at.lt.${nextMonth})`,
      order: 'created_at.desc,id',
      limit: '21'
    });
    const [transactionRows, accountRows, documentRows] = await Promise.all([
      this.fetch<SourceRow[]>(`/rest/v1/transactions?${transactions}`),
      this.fetch<SourceRow[]>(`/rest/v1/accounts?${accounts}`),
      this.fetch<SourceRow[]>(`/rest/v1/documents?${documents}`)
    ]);
    return { transactions: transactionRows, accounts: accountRows, documents: documentRows };
  }
}
