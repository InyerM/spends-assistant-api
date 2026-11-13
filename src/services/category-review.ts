import {
  reviewCategory,
  type CategoryReviewInput,
  type CategoryReviewResult
} from '../ai/category-review';
import type { SupabaseServices } from './supabase';
import type { Env } from '../types/env';

export class CategoryReviewQuotaError extends Error {}

/** Produces editable review metadata only; never posts or updates financial records. */
export async function reviewCategoryProposal(
  userId: string,
  input: CategoryReviewInput,
  env: Env,
  services: SupabaseServices
): Promise<CategoryReviewResult> {
  const [categories, history, rules] = await Promise.all([
    services.categories.getCategories(userId),
    services.categoryReviewContext.reviewHistory(
      userId,
      input.description,
      input.type,
      input.transaction_id,
      input.notes
    ),
    services.automationRules.getAutomationRules(userId)
  ]);
  const categoryRule = rules.find(
    (rule) =>
      rule.rule_type !== 'account_detection' &&
      !rule.conditions.to_account &&
      (!rule.conditions.category || rule.conditions.category === input.category_id) &&
      (rule.actions.set_category ||
        (Object.prototype.hasOwnProperty.call(rule.actions, 'set_category') &&
          rule.actions.set_category === null)) &&
      (!rule.actions.set_type || rule.actions.set_type === input.type) &&
      (rule.actions.set_category === null ||
        categories.some(
          (category) => category.id === rule.actions.set_category && category.type === input.type
        )) &&
      services.automationRules.matchesConditions(
        {
          description: input.description,
          raw_text: input.excerpt,
          amount: input.amount,
          account_id: input.account_id,
          source: input.source,
          category_id: input.category_id
        },
        rule.conditions,
        rule.condition_logic
      )
  );
  const requested = input.review_fields ?? ['category', 'description', 'notes'];
  const evidence =
    input.event_date &&
    (!categoryRule || requested.includes('description') || requested.includes('notes'))
      ? await services.categoryReviewContext.evidenceReview(
          userId,
          input,
          categories,
          await services.accounts.getAccounts(userId)
        )
      : null;
  const categoryResolved = Boolean(categoryRule || evidence?.categoryId);
  const categoryId = categoryRule
    ? (categoryRule.actions.set_category ?? null)
    : (evidence?.categoryId ?? null);
  const categorySource = categoryRule ? 'automation' : 'history';
  const category = categories.find((row) => row.id === categoryId);
  const name = category?.translations?.[input.locale] ?? category?.name ?? '';
  const categoryExplanation = categoryRule
    ? {
        es: 'Se aplicó tu regla de categoría.',
        en: 'Your category rule was applied.',
        pt: 'Sua regra de categoria foi aplicada.'
      }[input.locale]
    : {
        es: `El historial coincidente respalda ${name}.`,
        en: `Matching history supports ${name}.`,
        pt: `O histórico correspondente indica ${name}.`
      }[input.locale];
  const pending = requested.filter(
    (field) =>
      !(field === 'category' && categoryResolved) &&
      !(field === 'description' && evidence?.description)
  );
  const fieldSources: NonNullable<CategoryReviewResult['field_sources']> = {
    category: !requested.includes('category')
      ? 'original'
      : categoryResolved
        ? categorySource
        : 'ai',
    description: !requested.includes('description')
      ? 'original'
      : evidence?.description
        ? 'contact'
        : 'ai',
    notes: requested.includes('notes') ? 'ai' : 'original'
  };
  const recognized = evidence?.recognized_contact
    ? { recognized_contact: evidence.recognized_contact }
    : {};
  const original = { original_description: input.description };
  if (!pending.length) {
    return {
      category_id: requested.includes('category') ? categoryId : (input.category_id ?? null),
      description: requested.includes('description')
        ? (evidence?.description ?? input.description)
        : input.description,
      notes: input.notes ?? '',
      kind: input.type === 'transfer' ? 'own_transfer' : input.type,
      explanation:
        categoryResolved && requested.includes('category')
          ? categoryExplanation
          : {
              es: 'Se reconoció el contacto por su identificador completo.',
              en: 'The contact was recognized by its complete identifier.',
              pt: 'O contato foi reconhecido pelo identificador completo.'
            }[input.locale],
      evidence_ids:
        requested.includes('category') && !categoryRule
          ? (evidence?.evidenceIds.slice(0, 8) ?? [])
          : [],
      source: categoryResolved && requested.includes('category') ? categorySource : 'evidence',
      field_sources: fieldSources,
      ...recognized,
      ...original
    };
  }
  const mergedHistory = new Map<string, CategoryReviewInput['history'][number]>();
  for (const row of [...(evidence?.history ?? []), ...history])
    if (!mergedHistory.has(row.id)) mergedHistory.set(row.id, row);
  await services.aiUsage.requireConsent(userId, 'financial_text');
  const context = {
    ...(categoryResolved
      ? {
          categoryResolution: {
            category_id: categoryId,
            source: categorySource,
            explanation: categoryExplanation
          }
        }
      : {}),
    preferences: rules
      .map((rule) => rule.prompt_text?.slice(0, 1000))
      .filter((value): value is string => Boolean(value))
      .slice(0, 12),
    ...(categoryRule?.actions.set_category
      ? {
          categoryRule: {
            category_id: categoryRule.actions.set_category,
            name: categoryRule.name.slice(0, 100)
          }
        }
      : {})
  };
  const quota = await services.usage.incrementAiParses(userId);
  if (!quota.allowed) throw new CategoryReviewQuotaError();
  const model = env.OPENROUTER_TEXT_MODEL ?? 'deepseek/deepseek-v4.1-flash';
  const result = await services.aiUsage.track(
    { userId, operation: 'parse_expense', model },
    (meter) =>
      reviewCategory(
        { ...input, review_fields: pending, history: [...mergedHistory.values()].slice(0, 12) },
        categories,
        env.OPENROUTER_API_KEY,
        model,
        meter,
        context
      )
  );
  const protectedCategory = requested.includes('category') && categoryResolved;
  return {
    ...result,
    category_id: !requested.includes('category')
      ? (input.category_id ?? null)
      : protectedCategory
        ? categoryId
        : result.category_id,
    description: !requested.includes('description')
      ? input.description
      : (evidence?.description ?? result.description),
    notes: requested.includes('notes') ? result.notes : (input.notes ?? ''),
    ...(!requested.includes('category')
      ? { kind: input.type === 'transfer' ? 'own_transfer' : input.type }
      : {}),
    ...(protectedCategory
      ? {
          kind: input.type === 'transfer' ? 'own_transfer' : input.type,
          explanation: categoryExplanation,
          evidence_ids: categoryRule ? [] : (evidence?.evidenceIds.slice(0, 8) ?? [])
        }
      : {}),
    source:
      protectedCategory || (requested.includes('description') && evidence?.description)
        ? 'mixed'
        : 'ai',
    field_sources: fieldSources,
    ...recognized,
    ...original
  };
}
