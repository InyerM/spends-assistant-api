-- A currency ledger shares the identity of its physical root account.
DROP INDEX public.accounts_owner_bank_account_suffix_idx;
CREATE UNIQUE INDEX accounts_owner_bank_account_suffix_idx
 ON public.accounts(user_id,lower(institution),bank_account_last_four)
 WHERE parent_account_id IS NULL AND bank_account_last_four IS NOT NULL AND deleted_at IS NULL;
