import { expect, it } from 'vitest';
import { resolveExactHistoryCategory } from '../../src/utils/inbox-history-resolution';
import { createMockCategory } from '../__test-helpers__/factories';
const category = createMockCategory({ user_id: 'owner' });
const row = {
  id: 'one',
  user_id: 'owner',
  description: 'SPOTIFY',
  type: 'expense',
  date: '2026-10-01',
  category_id: category.id
};
const resolve = (rows = [row, { ...row, id: 'two', date: '2026-09-01' }]) =>
  resolveExactHistoryCategory('owner', 'SPOTIFY', 'expense', '2026-10-02', [category], rows);
it('resolves only consistent recent exact owner history with distinct evidence', () => {
  expect(resolve()).toEqual({ categoryId: category.id, evidenceIds: ['one', 'two'] });
});
it('abstains on conflicts, duplicates, foreign ownership, stale or future history', () => {
  for (const changed of [
    { category_id: 'other' },
    { id: 'one' },
    { user_id: 'foreign' },
    { date: '2025-01-01' },
    { date: '2026-10-03' },
    { description: 'SPOTIFY FAMILY' },
    { type: 'income' }
  ]) {
    expect(resolve([row, { ...row, id: 'two', ...changed }])).toBeNull();
  }
  expect(
    resolveExactHistoryCategory(
      'owner',
      'SPOTIFY',
      'expense',
      'invalid',
      [category],
      [row, { ...row, id: 'two' }]
    )
  ).toBeNull();
  expect(
    resolveExactHistoryCategory(
      'owner',
      'SPOTIFY',
      'expense',
      '2026-10-02',
      [{ ...category, is_active: false }],
      [row, { ...row, id: 'two' }]
    )
  ).toBeNull();
});
it('abstains when the bounded window is saturated or the category is not owned', () => {
  expect(
    resolve(Array.from({ length: 13 }, (_, index) => ({ ...row, id: String(index) })))
  ).toBeNull();
  expect(
    resolveExactHistoryCategory(
      'owner',
      'SPOTIFY',
      'expense',
      '2026-10-02',
      [{ ...category, user_id: 'foreign' }],
      [row, { ...row, id: 'two' }]
    )
  ).toBeNull();
});
