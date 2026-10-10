import { afterEach, expect, it, vi } from 'vitest';
import {
  backfillCounterparties,
  parseBackfillArguments
} from '../scripts/maintenance/backfill-counterparties';
afterEach(() => vi.unstubAllGlobals());
it('includes every page and stops on a stalled cursor', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json([
        { result: { processed: 2, next: '00000000-0000-4000-8000-000000000001', has_more: true } }
      ])
    )
    .mockResolvedValueOnce(
      Response.json([
        { result: { processed: 1, next: '00000000-0000-4000-8000-000000000002', has_more: false } }
      ])
    );
  vi.stubGlobal('fetch', fetch);
  const options = {
    project: 'abcdefghijklmnopqrst',
    owner: '00000000-0000-4000-8000-000000000099',
    token: 'synthetic',
    pageSize: 2,
    apply: true
  };
  expect(await backfillCounterparties(options)).toEqual({ processed: 3, pages: 2, applied: true });
  fetch.mockImplementation(async () =>
    Response.json([
      { result: { processed: 2, next: '00000000-0000-4000-8000-000000000001', has_more: true } }
    ])
  );
  await expect(backfillCounterparties(options)).rejects.toThrow('Scan cursor stalled');
});

it('rejects malformed owner IDs before sending a query', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    backfillCounterparties({
      project: 'abcdefghijklmnopqrst',
      owner: '------------------------------------',
      token: 'synthetic',
      pageSize: 200,
      apply: true
    })
  ).rejects.toThrow('Invalid backfill parameters');
  expect(fetch).not.toHaveBeenCalled();
});

it('defaults to a dry run and a full-size page when optional flags are absent', () => {
  const parsed = parseBackfillArguments(
    ['--project-ref', 'abcdefghijklmnopqrst', '--owner-id', '00000000-0000-4000-8000-000000000099'],
    'synthetic'
  );
  expect(parsed.pageSize).toBe(200);
  expect(parsed.apply).toBe(false);
});
