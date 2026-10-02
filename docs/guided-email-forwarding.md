# Guided email forwarding intake

The Email Worker receives new messages at a random address owned by one user and saves each readable notice in `shortcut_inbox_items` with `source = 'forwarded_email'` and `status = 'pending'`. Intake does not parse a transaction, select an account, change a balance, or call the legacy `/email` writer. The reviewer decides what to do in the web inbox.

## Release prerequisites

1. Apply `20261002000020_email_forwarding_routes.sql` before deploying the Worker. The table exposes only the owner's route to authenticated database reads; route writes use the Worker service role.
2. Configure `EMAIL_FORWARDING_DOMAIN` on the Worker as a lowercase apex domain dedicated to this intake, with Cloudflare Email Routing enabled. Configure a catch-all rule that sends mail for this domain to this Worker. Unknown recipients are rejected, so do not redirect a domain that receives unrelated mail. [Cloudflare currently limits wildcard catch-all entries to apex domains](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/); a subdomain requires literal routes and cannot support these random addresses. The repository's Wrangler version does not manage `addresses` rules, so configure the rule in Cloudflare before enabling the web flow.
3. Deploy the Worker after the database migration and routing rule. Run one synthetic confirmation and one synthetic bank notice end to end before offering the route to users. Use redacted fixtures and verify owner isolation, idempotency, and inbox review. No live email or credential is needed for local tests.

## Authenticated HTTP contract

`GET /email-forwarding-route` returns `{ "status": "unconfigured" }` or `{ "status": "active", "address": string, "created_at": string, "confirmation_received_at": string | null, "verification_text": string | null }`.

`POST /email-forwarding-route` accepts no body and returns the active route with HTTP 201. Repeating it returns the same address. `DELETE /email-forwarding-route` returns HTTP 204 and revokes the address; a subsequent POST creates a new one. All three requests require a user Bearer token accepted by `resolveUserId()`. Web clients should proxy these calls server-side with the signed-in user's Supabase access token, never a shared API key in the browser. Responses have `Cache-Control: private, no-store`.

The `confirmation_received_at` value means a Gmail confirmation message arrived; it does not mean the user clicked the link or enabled a filter. `verification_text` is bounded plain text from that message for the owner to complete Gmail's verification step. The Worker identifies this message by envelope sender and subject; it does not claim that visible email headers prove sender authenticity.

## User setup

After the user creates the route, Gmail requires adding the destination, opening the verification link from the confirmation message, and then creating a filter that forwards only the chosen bank senders. [Gmail forwards only new messages after setup and supports forwarding through a filter](https://support.google.com/mail/answer/10957?hl=en). Keep forwarding of all mail disabled. Revoking the route in the app stops intake at the Worker; the user should also remove the Gmail filter and forwarding address in Gmail.

## Intake limits and deduplication

The Worker resolves ownership from the envelope recipient alone, caps raw MIME at 512 KiB, parses multipart mail with `postal-mime`, and stores at most 4,096 text characters. It ignores attachments. The SHA-256 digest of Message-ID is the stable external ID when present; otherwise a digest of subject, date, and body is used. A retry with the same identity and content is accepted without resetting the item's reviewed status. A changed body under the same identity fails closed. Duplicate SMS and email notices remain separate evidence for review; no automatic financial merge occurs.

The route address is an unguessable bearer-like destination. Anyone who learns it can send pending evidence until the user revokes it. The first release relies on the user's Gmail sender filter and manual review, without trusting the visible `From` header to choose ownership or authorize a transaction.
