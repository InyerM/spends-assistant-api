ALTER TABLE public.email_forwarding_routes
  DROP CONSTRAINT email_forwarding_routes_address_check;

ALTER TABLE public.email_forwarding_routes
  ADD CONSTRAINT email_forwarding_routes_address_check CHECK (
    length(address) BETWEEN 20 AND 320
    AND address ~ '^(f-[a-f0-9]{64}|capture[+][a-f0-9]{64})@[a-z0-9.-]+$'
  );
