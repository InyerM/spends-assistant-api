# Statement reconciliation

Approved scope: statement reconciliation creates evidence links only. It never creates transactions or adjusts balances. Show statement-only rows and Anotto-only transactions within an explicitly confirmed account, currency and statement period. Do not infer the full cycle from the earliest/latest extracted movement.

Use a dedicated statement screen instead of the receipt posting workflow. Reuse searchable account and date range controls. Exact amount, currency, date and direction matches are suggestions until the owner confirms them. Ambiguous matches require an explicit selection. Missing or unverified fields cannot produce a reconciled badge.

Keep reconciliation evidence separate from receipt provenance: a transaction can have both its original receipt and a statement confirmation. Owner-scoped SQL functions lock the selected scope and financial rows, enforce one-to-one matching within a statement, retain immutable snapshots and allow an audited reversal. Financial changes or deletion invalidate the proof; notes and description edits do not. No statement may claim full balance reconciliation from matching movement rows alone.

Validation: owner isolation, direct write denial, replay safety, immutable evidence, financial edit invalidation, transfer direction, missing rows on both sides, duplicate ambiguity and unchanged balances. Release web before mobile.
