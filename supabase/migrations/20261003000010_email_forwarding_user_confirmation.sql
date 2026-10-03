ALTER TABLE public.email_forwarding_routes
  ADD COLUMN user_confirmed_at timestamptz;

ALTER TABLE public.email_forwarding_routes
  ADD CONSTRAINT email_forwarding_user_confirmation_requires_message
  CHECK (user_confirmed_at IS NULL OR confirmation_received_at IS NOT NULL);
