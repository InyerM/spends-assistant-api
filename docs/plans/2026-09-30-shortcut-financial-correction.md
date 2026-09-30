# Shortcut match financial correction

`correct_shortcut_matched_expense` provides a narrow, owner-scoped correction for an expense that already has an active Shortcut match decision. It supports moving the expense to the account shown by a bank statement and, when a posted amount differs from the notification authorization, replacing the amount with the settled value. It does not change the transaction ID, date, type, category, raw message, or original match snapshot.

The caller supplies a UUID request ID, transaction and active match decision IDs, the currently observed account and amount, the verified destination account, an optional settled amount (`null` retains the current amount), and statement evidence. Evidence must identify a bank statement document, page, and line. The correction rejects cross-owner IDs, reversed matches, document-reviewed transactions, non-expenses, inactive destination accounts, stale account or amount expectations, and no-op account changes. Different data with a reused request ID is an error. An identical retry returns the original correction record with `replayed: true` and makes no new balance change.

The RPC uses the same owner advisory lock as manual financial writes, locks the related inbox item to serialize match reversal, then locks both accounts in UUID order before the transaction. One database transaction updates the existing expense, restores its prior debit to the old account, debits the settled amount from the new account, and inserts an owner-readable append-only correction record. The original Shortcut decision remains unchanged; the correction record holds its ID, both financial states, request ID, timestamp, and statement evidence. Privacy erasure of a hard-deleted transaction cascades to its correction records, as it does for Shortcut decision snapshots.

Example using synthetic IDs and amounts:

```sql
SELECT public.correct_shortcut_matched_expense(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd'::uuid,
  100.00,
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid,
  100.25,
  '{"source":"bank_statement","document":"Q2 savings statement","page":3,"line":"posting 42"}'::jsonb
);
```

This migration only adds the database correction path. It does not apply any historical correction or establish an account balance baseline. Each real posting needs a reviewed statement match before calling the RPC. The web form can later gather that evidence and call this RPC; generic `patch_reviewed_transaction` deliberately continues to reject transactions with active Shortcut matches.
