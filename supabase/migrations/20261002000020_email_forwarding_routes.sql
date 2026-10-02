CREATE TABLE public.email_forwarding_routes (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  address text NOT NULL UNIQUE CHECK (
    length(address) BETWEEN 20 AND 320
    AND address ~ '^f-[a-f0-9]{64}@[a-z0-9.-]+$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmation_received_at timestamptz,
  verification_text text CHECK (
    verification_text IS NULL OR length(verification_text) BETWEEN 1 AND 2048
  )
);

ALTER TABLE public.email_forwarding_routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_forwarding_routes_owner ON public.email_forwarding_routes
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
REVOKE ALL ON public.email_forwarding_routes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.email_forwarding_routes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_forwarding_routes TO service_role;
