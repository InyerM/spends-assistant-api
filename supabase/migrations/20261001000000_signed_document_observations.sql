-- Preserve the sign shown by bank and card screenshots. Zero-value status rows
-- are not financial movements and remain ineligible for observation amounts.
ALTER TABLE public.document_observations
  DROP CONSTRAINT document_observations_amount_check;

ALTER TABLE public.document_observations
  ADD CONSTRAINT document_observations_amount_check
  CHECK (amount IS NULL OR amount <> 0);
