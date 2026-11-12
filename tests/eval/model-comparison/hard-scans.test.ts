import { expect, it } from 'vitest';
import {
  scoreHardRows,
  parseHardJson,
  HARD_CASES
} from '../../../scripts/eval/model-comparison/hard-scans-fixtures';
it('keeps literal sign separate from debit direction and counts duplicate references', () => {
  const rows = HARD_CASES[0].rows;
  expect(scoreHardRows(rows, rows).pass).toBe(true);
  expect(scoreHardRows(rows, [...rows, rows[0]]).duplicates).toBe(1);
  expect(
    scoreHardRows(rows, [{ ...rows[0], amount: -rows[0].amount }, ...rows.slice(1)]).signCorrect
  ).toBe(rows.length - 1);
});
it('normalizes only a complete JSON fence, rejects surrounding prose', () => {
  expect(parseHardJson('```json\n{"rows":[]}\n```').strict).toBe(false);
  expect(parseHardJson('prefix {"rows":[]}').data).toBe(null);
  expect(parseHardJson('```json\n{"rows":[]}').data).toBe(null);
});

it('requires explicit debit or credit direction in the full schema', () => {
  const rows = HARD_CASES[0].rows;
  expect(
    scoreHardRows(
      rows,
      rows.map(({ direction: _direction, ...row }) => row)
    ).schemaValid
  ).toBe(false);
});
