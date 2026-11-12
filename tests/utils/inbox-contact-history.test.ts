import { expect, it } from 'vitest';
import { resolveInboxHistoryCategory } from '../../src/utils/inbox-history-resolution';
import { createMockCategory } from '../__test-helpers__/factories';
const category = createMockCategory({ user_id: 'owner' });
const row = {
  id: 'one',
  user_id: 'owner',
  description: 'Monthly lesson',
  type: 'expense',
  date: '2026-10-01',
  category_id: category.id,
  contact_id: 'contact'
};
const contact = {
  contactId: 'contact',
  rows: [row, { ...row, id: 'two', description: 'Tuition' }]
};
const resolve = (value = contact, exact = [] as (typeof row)[]) =>
  resolveInboxHistoryCategory(
    'owner',
    'EXPLICIT DESTINATION',
    'expense',
    '2026-10-02',
    [category],
    exact,
    value
  );
it('resolves a verified contact from consistent history without matching display names', () => {
  expect(resolve()).toEqual({
    categoryId: category.id,
    evidenceIds: ['one', 'two'],
    contactId: 'contact'
  });
});
it('abstains on conflicting exact/contact history and invalid contact linkage', () => {
  expect(
    resolve({ ...contact, rows: [row, { ...row, id: 'two', category_id: 'other' }] })
  ).toBeNull();
  expect(
    resolve({ ...contact, rows: [row, { ...row, id: 'two', contact_id: 'other' }] })
  ).toBeNull();
  expect(
    resolve(contact, [
      { ...row, id: 'three', description: 'EXPLICIT DESTINATION', category_id: 'other' }
    ])
  ).toBeNull();
  expect(
    resolve({ ...contact, rows: [row, { ...row, id: 'two', date: '2026-10-03' }] })
  ).toBeNull();
});
it('abstains on saturation, ambiguous identity and duplicate conflicting observations', () => {
  expect(resolve({ ...contact, ambiguous: true })).toBeNull();
  expect(
    resolve({ ...contact, rows: Array.from({ length: 13 }, (_, i) => ({ ...row, id: String(i) })) })
  ).toBeNull();
  expect(
    resolve(contact, [{ ...row, description: 'EXPLICIT DESTINATION', category_id: 'other' }])
  ).toBeNull();
});
