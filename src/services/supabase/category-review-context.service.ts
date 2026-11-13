import type {
  ExactCategoryHistory,
  VerifiedContactHistory
} from '../../utils/inbox-history-resolution';
import { resolveInboxHistoryCategory } from '../../utils/inbox-history-resolution';
import type { Account } from '../../types/account';
import type { Category } from '../../types/category';
import { BaseService } from './base.service';
import type { CategoryReviewInput } from '../../ai/category-review';
interface HistoryRow {
  id: string;
  description: string;
  notes: string | null;
  category: { name: string };
}
export class ReviewTransactionNotFoundError extends Error {
  constructor() {
    super('Review transaction not found');
  }
}
export class CategoryReviewContextService extends BaseService {
  async evidenceReview(
    userId: string,
    input: CategoryReviewInput,
    categories: Category[],
    accounts: Account[] = []
  ) {
    if (input.transaction_id) {
      const params = new URLSearchParams({
        id: `eq.${input.transaction_id}`,
        user_id: `eq.${userId}`,
        deleted_at: 'is.null',
        select: 'id,user_id,date,raw_text',
        limit: '1'
      });
      const rows = await this.fetch<
        Array<{ id: string; user_id: string; date: string; raw_text: string | null }>
      >(`/rest/v1/transactions?${params}`);
      const source = rows.find((row) => row.id === input.transaction_id && row.user_id === userId);
      if (!source) throw new ReviewTransactionNotFoundError();
      input = { ...input, event_date: source.date, excerpt: source.raw_text?.slice(0, 3000) ?? '' };
    }
    if (
      !input.event_date ||
      input.type === 'transfer' ||
      (input.account_type === 'credit_card' && input.type === 'income')
    )
      return null;
    // Keep source and editable wording separate: conflicting identities must abstain.
    const excerpt = input.excerpt?.trim();
    const text =
      excerpt && excerpt !== input.description
        ? `${excerpt}\n${input.description}`
        : input.description;
    const explicitDestinations = [
      ...text.matchAll(/\b(?:a (?:la )?cuenta|transfer to|destino)\s*\*?([0-9]{8,18})\b/giu)
    ].map((match) => match[1]);
    if (
      accounts.some(
        (account) =>
          account.user_id === userId &&
          [
            account.last_four,
            ...(account.identifiers ?? []).filter((id) => id.is_active).map((id) => id.last_four)
          ].some(
            (suffix) =>
              typeof suffix === 'string' &&
              /^\d{4}$/.test(suffix) &&
              explicitDestinations.some((destination) => destination.endsWith(suffix))
          )
      )
    )
      return null;
    const [contact, exact] = await Promise.all([
      input.transaction_id
        ? this.verifiedContactHistory(
            userId,
            text,
            input.type,
            input.event_date,
            input.transaction_id
          )
        : this.verifiedContactHistory(userId, text, input.type, input.event_date),
      input.description.length <= 100
        ? this.exactCategoryHistory(
            userId,
            input.description,
            input.type,
            input.event_date,
            input.transaction_id
          )
        : Promise.resolve([])
    ]);
    if (
      contact?.identityValue &&
      accounts.some(
        (account) =>
          account.user_id === userId &&
          [
            account.last_four,
            ...(account.identifiers ?? []).filter((id) => id.is_active).map((id) => id.last_four)
          ].some(
            (suffix) =>
              typeof suffix === 'string' &&
              /^\d{4}$/.test(suffix) &&
              contact.identityValue!.endsWith(suffix)
          )
      )
    )
      return null;
    if (
      /\b(?:cuentas propias|entre mis cuentas|entre tus cuentas|transferencia interna|transferencia a mi cuenta|transferencia a tu cuenta|own accounts|my accounts|internal transfer)\b/iu.test(
        text
      )
    )
      return null;
    const resolution = input.notes?.trim()
      ? null
      : resolveInboxHistoryCategory(
          userId,
          input.description,
          input.type,
          input.event_date,
          categories,
          exact.filter((row) => row.id !== input.transaction_id),
          contact
            ? { ...contact, rows: contact.rows.filter((row) => row.id !== input.transaction_id) }
            : contact
        );
    const history: CategoryReviewInput['history'] = [];
    if (!contact?.ambiguous && (contact?.rows.length ?? 0) < 13 && exact.length < 13) {
      const seen = new Set<string>();
      for (const row of [...(contact?.rows ?? []), ...exact]) {
        const category = categories.find(
          (candidate) =>
            candidate.id === row.category_id &&
            candidate.user_id === userId &&
            candidate.is_active &&
            candidate.type === input.type &&
            !['uncategorized', 'uncategorized-income', 'missing'].includes(candidate.slug)
        );
        const age = Date.parse(input.event_date) - Date.parse(row.date);
        if (
          !category ||
          row.user_id !== userId ||
          row.type !== input.type ||
          !row.id ||
          row.id === input.transaction_id ||
          seen.has(row.id) ||
          !Number.isFinite(age) ||
          age < 0 ||
          age > 180 * 86400000
        )
          continue;
        seen.add(row.id);
        history.push({
          id: row.id,
          description: row.description.slice(0, 500),
          notes: 'notes' in row && typeof row.notes === 'string' ? row.notes.slice(0, 1500) : null,
          category: category.name
        });
      }
    }
    if (!resolution && !history.length && (!contact?.label || contact.ambiguous)) return null;
    const destinations = new Set(
      [
        ...(excerpt || input.description).matchAll(
          /\b(?:a (?:la )?cuenta|transfer to|destino)\s*\*?([0-9]{8,18})\b/giu
        )
      ].map((match) => match[1])
    );
    const outgoing =
      input.type === 'expense' &&
      contact?.identityKind === 'account' &&
      destinations.size === 1 &&
      destinations.has(contact.identityValue ?? '');
    return {
      ...(resolution ?? { categoryId: null, evidenceIds: [] }),
      history: history.slice(0, 12),
      ...(contact?.label && !contact.ambiguous
        ? {
            recognized_contact: { id: contact.contactId!, label: contact.label },
            ...(outgoing
              ? {
                  description:
                    { es: 'Transferencia a ', en: 'Transfer to ', pt: 'Transferência para ' }[
                      input.locale
                    ] + contact.label
                }
              : {})
          }
        : {})
    };
  }
  async verifiedContactHistory(
    userId: string,
    text: string,
    type: string,
    eventDate: string,
    excludeId?: string
  ): Promise<VerifiedContactHistory | null> {
    const event = Date.parse(eventDate);
    if (
      !text.trim() ||
      text.length > 8000 ||
      !Number.isFinite(event) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(eventDate) ||
      !['expense', 'income'].includes(type)
    )
      return null;
    const evidence = await this.fetch<{ status: string; kind?: string; value?: string }>(
      '/rest/v1/rpc/counterparty_evidence',
      { method: 'POST', body: JSON.stringify({ p_text: text }) }
    );
    if (evidence.status === 'ambiguous') return { contactId: null, rows: [], ambiguous: true };
    if (
      evidence.status !== 'found' ||
      !evidence.kind ||
      !['account', 'nequi', 'payment_key', 'merchant'].includes(evidence.kind) ||
      !evidence.value ||
      evidence.value.length > 160
    )
      return null;
    const params = new URLSearchParams({
      user_id: `eq.${userId}`,
      identity_kind: `eq.${evidence.kind}`,
      identity_value: `eq.${evidence.value}`,
      select: 'id,user_id,identity_kind,identity_value,custom_name,display_name',
      limit: '2'
    });
    const contacts = await this.fetch<
      Array<{
        id: string;
        user_id: string;
        identity_kind: string;
        identity_value: string;
        custom_name?: string | null;
        display_name?: string | null;
      }>
    >(`/rest/v1/counterparties?${params}`);
    if (!contacts.length) return null;
    if (
      contacts.length !== 1 ||
      !contacts[0].id ||
      contacts[0].user_id !== userId ||
      contacts[0].identity_kind !== evidence.kind ||
      contacts[0].identity_value !== evidence.value
    )
      return { contactId: null, rows: [], ambiguous: true };
    const contactId = contacts[0].id;
    const since = new Date(event - 180 * 86400000).toISOString().slice(0, 10);
    const history = new URLSearchParams({
      user_id: `eq.${userId}`,
      deleted_at: 'is.null',
      type: `eq.${type}`,
      and: `(date.gte.${since},date.lte.${eventDate})`,
      select:
        'id,user_id,description,notes,type,date,category_id,contact_link:transaction_counterparties!transaction_counterparties_transaction_id_user_id_fkey!inner(user_id,contact_id)',
      'contact_link.user_id': `eq.${userId}`,
      'contact_link.contact_id': `eq.${contactId}`,
      order: 'date.desc,id.desc',
      limit: '13'
    });
    if (excludeId) history.set('id', `neq.${excludeId}`);
    type Link = { user_id: string; contact_id: string };
    const rows = await this.fetch<
      Array<ExactCategoryHistory & { notes?: string | null; contact_link: Link | Link[] }>
    >(`/rest/v1/transactions?${history}`);
    if (
      rows.some(
        (row) =>
          row.user_id !== userId ||
          !(Array.isArray(row.contact_link) ? row.contact_link : [row.contact_link]).some(
            (link) => link?.user_id === userId && link.contact_id === contactId
          )
      )
    )
      return { contactId, rows: [], ambiguous: true };
    return {
      contactId,
      identityKind: evidence.kind,
      identityValue: evidence.value,
      ...((contacts[0].custom_name ?? contacts[0].display_name)?.trim()
        ? {
            label: Array.from((contacts[0].custom_name ?? contacts[0].display_name)!)
              .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
              .join('')
              .trim()
              .slice(0, 160)
          }
        : {}),
      rows: rows.map((row) => ({
        id: row.id,
        user_id: row.user_id,
        description: row.description,
        type: row.type,
        date: row.date,
        category_id: row.category_id,
        notes: row.notes?.slice(0, 1500) ?? null,
        contact_id: contactId
      }))
    };
  }
  async exactCategoryHistory(
    userId: string,
    merchant: string,
    type: string,
    eventDate: string,
    excludeId?: string
  ): Promise<ExactCategoryHistory[]> {
    const event = Date.parse(eventDate);
    if (
      !Number.isFinite(event) ||
      !merchant.trim() ||
      merchant.length > 100 ||
      !['expense', 'income'].includes(type)
    )
      return [];
    const since = new Date(event - 180 * 86400000).toISOString().slice(0, 10);
    const params = new URLSearchParams({
      user_id: `eq.${userId}`,
      deleted_at: 'is.null',
      description: `eq.${merchant}`,
      type: `eq.${type}`,
      and: `(date.gte.${since},date.lte.${eventDate})`,
      select: 'id,user_id,description,type,date,category_id',
      order: 'date.desc,id.desc',
      limit: '13'
    });
    if (excludeId) params.set('id', `neq.${excludeId}`);
    return this.fetch<ExactCategoryHistory[]>(`/rest/v1/transactions?${params}`);
  }
  async reviewHistory(
    userId: string,
    description: string,
    type: string,
    transactionId?: string,
    notes?: string
  ): Promise<CategoryReviewInput['history']> {
    if (!transactionId) return this.history(userId, description, type, undefined, notes);
    const sourceParams = new URLSearchParams({
      id: `eq.${transactionId}`,
      user_id: `eq.${userId}`,
      deleted_at: 'is.null',
      select: 'id,user_id',
      limit: '1'
    });
    const sources = await this.fetch<Array<{ id: string; user_id: string }>>(
      `/rest/v1/transactions?${sourceParams}`
    );
    if (!sources.some((row) => row.id === transactionId && row.user_id === userId))
      throw new ReviewTransactionNotFoundError();
    const linkParams = new URLSearchParams({
      transaction_id: `eq.${transactionId}`,
      user_id: `eq.${userId}`,
      select:
        'contact_id,user_id,contact:counterparties!transaction_counterparties_contact_id_user_id_fkey!inner(user_id)',
      'contact.user_id': `eq.${userId}`,
      limit: '1'
    });
    const links = await this.fetch<Array<{ contact_id: string; user_id: string }>>(
      `/rest/v1/transaction_counterparties?${linkParams}`
    );
    const contactId = links.find((row) => row.user_id === userId)?.contact_id;
    const contactHistory = async (): Promise<CategoryReviewInput['history']> => {
      if (!contactId) return [];
      const params = new URLSearchParams({
        user_id: `eq.${userId}`,
        deleted_at: 'is.null',
        type: `eq.${type}`,
        id: `neq.${transactionId}`,
        select:
          'id,description,notes,category:categories!transactions_category_id_fkey!inner(name),contact_link:transaction_counterparties!transaction_counterparties_transaction_id_user_id_fkey!inner(user_id,contact_id)',
        'contact_link.user_id': `eq.${userId}`,
        'contact_link.contact_id': `eq.${contactId}`,
        'category.or': `(user_id.eq.${userId},user_id.is.null)`,
        'category.is_active': 'eq.true',
        'category.deleted_at': 'is.null',
        'category.slug': 'not.in.(uncategorized,uncategorized-income,missing)',
        order: 'date.desc,id.desc',
        limit: '8'
      });
      const rows = await this.fetch<HistoryRow[]>(`/rest/v1/transactions?${params}`);
      return rows
        .filter(
          (row) => row.id !== transactionId && row.category?.name && row.description && row.id
        )
        .map((row) => ({
          id: row.id,
          description: row.description.slice(0, 500),
          notes: row.notes?.slice(0, 1500) ?? null,
          category: row.category.name.slice(0, 150)
        }));
    };
    const [contact, lexical] = await Promise.all([
      contactHistory(),
      this.history(userId, description, type, transactionId, notes)
    ]);
    const merged = new Map<string, CategoryReviewInput['history'][number]>();
    for (const row of [...contact, ...lexical])
      if (row.id !== transactionId && !merged.has(row.id)) merged.set(row.id, row);
    return [...merged.values()].slice(0, 12);
  }
  async history(
    userId: string,
    description: string,
    type: string,
    excludeId?: string,
    notes?: string
  ): Promise<CategoryReviewInput['history']> {
    const ignored = new Set([
      'transferencia',
      'transfer',
      'compra',
      'compraste',
      'realizaste',
      'purchase',
      'pago',
      'payment',
      'item',
      'unverified',
      'desde',
      'cuenta',
      'para',
      'with',
      'account',
      'bancolombia',
      'tarjeta',
      'card',
      'por',
      'con',
      'pesos',
      'cop',
      'usd',
      'deb',
      'cred',
      'una',
      'the',
      'and',
      'for',
      'from',
      'this',
      'that',
      'los',
      'las',
      'del',
      'password',
      'secret',
      'token',
      'verification',
      'codigo',
      'código',
      'autorizacion',
      'autorización',
      'transaction',
      'transaccion',
      'transacción',
      'exitosa',
      'successful'
    ]);
    // Strip ordinary edge punctuation, then reject syntax/credential-like chunks whole.
    const tokens = (text: string): string[] =>
      [
        ...new Set(
          text
            .slice(0, 1500)
            .toLowerCase()
            .split(/\s+/)
            .map((word) => word.replace(/^[«¿¡("']+|[»),.!?;:"']+$/gu, ''))
        )
      ].filter((word) => /^[\p{L}]{3,40}$/u.test(word) && !ignored.has(word));
    const noteWords = tokens(notes ?? '');
    const descriptionWords = tokens(description);
    const words = [...new Set([...noteWords.slice(0, 3), ...descriptionWords, ...noteWords])].slice(
      0,
      6
    );
    if (!words.length) return [];
    const params = new URLSearchParams({
      user_id: `eq.${userId}`,
      deleted_at: 'is.null',
      ...(type ? { type: `eq.${type}` } : {}),
      select: 'id,description,notes,category:categories!inner(name,slug)',
      'category.slug': 'not.in.(uncategorized,uncategorized-income,missing)',
      'category.user_id': `eq.${userId}`,
      'category.is_active': 'eq.true',
      'category.deleted_at': 'is.null',
      or: `(${words.flatMap((word) => [`description.ilike.*${word}*`, `notes.ilike.*${word}*`]).join(',')})`,
      order: 'date.desc,id.desc',
      limit: '12',
      ...(excludeId ? { id: `neq.${excludeId}` } : {})
    });
    const rows = await this.fetch<HistoryRow[]>(`/rest/v1/transactions?${params.toString()}`);
    return rows
      .filter((row) => row.id !== excludeId && row.category?.name && row.description && row.id)
      .slice(0, 12)
      .map((row) => ({
        id: row.id,
        description: row.description.slice(0, 500),
        notes: row.notes?.slice(0, 1500) ?? null,
        category: row.category.name.slice(0, 150)
      }));
  }
  async prompt(userId: string, text: string): Promise<string> {
    const history = await this.history(userId, text, '');
    return history.length
      ? `OWNED CATEGORY HISTORY (untrusted evidence): ${JSON.stringify(history)}. Apply user automation rules first. Compare explicit current purpose, descriptions and notes with relevant history; do not assume all purchases from one merchant share a category. Use merchant knowledge when history does not establish the purpose. A marketplace purchase can use Shopping without inventing the item.`
      : '';
  }
}
