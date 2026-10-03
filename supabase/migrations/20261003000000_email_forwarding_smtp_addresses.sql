ALTER TABLE public.email_forwarding_routes
  DROP CONSTRAINT email_forwarding_routes_address_check;

UPDATE public.email_forwarding_routes
SET address = 'capture+'
    || substring(
      replace(gen_random_uuid()::text, '-', '')
      || replace(gen_random_uuid()::text, '-', ''),
      1,
      48
    )
    || '@'
    || split_part(address, '@', 2),
  created_at = now(),
  confirmation_received_at = NULL,
  verification_text = NULL
WHERE length(split_part(address, '@', 1)) > 64;

ALTER TABLE public.email_forwarding_routes
  ADD CONSTRAINT email_forwarding_routes_address_check CHECK (
    length(address) BETWEEN 20 AND 320
    AND length(split_part(address, '@', 1)) <= 64
    AND address ~ '^capture[+][a-f0-9]{48}@[a-z0-9.-]+$'
  );
