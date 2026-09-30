# 2026 Shortcut backfill preparation

Status: local offline preparation only. The web inbox, database migrations, and reviewed financial actions must be released and verified before any personal messages are sent. This procedure does not post to an API or create transactions.

## Available path

The web app already exposes `POST /api/shortcut-inbox` for private JSON batches, `GET /api/shortcut-inbox/export` for a signed-in owner's inbox, and `/transactions/shortcut-inbox` for reviewed matching or creation. The backend script `scripts/shortcut-backfill.mjs` turns a locally saved canonical message list into bounded POST bodies. It filters by **receipt instant in America/Bogota during 2026**, removes repeated input messages, and optionally omits items already present in an inbox export from the **same source**. It does not compare against financial transactions. That comparison happens in the web review flow using raw-message and bounded amount/date/account candidates; equal amounts alone are not proof of duplication.

The older `scripts/send-bulk.js` sent each string directly to the Worker `/transaction` route. That route parses and can create a financial row; it is unsuitable for unattended historical replay. A Scriptable copy installed on a phone will not change when this repository changes. Stop using that copy for backfill, revoke its embedded API key, and create a fresh key for the reviewed inbox after deployment.

The read-only transaction audit on September 28 found 1,516 active rows and a latest transaction date of **2026-09-07**. This is a point-in-time cutoff, not a verified current database cutoff. A later live refresh was unavailable because the Supabase network request failed. Record the current cutoff again before a real backfill.

## Private input and command

Use original receipt timestamps with a timezone. The script accepts an array of message objects or one canonical batch object. Keep real messages and inbox exports outside Git. The example below is synthetic.

```json
{
  "source": "sms-manual-backfill",
  "items": [
    {
      "received_at": "2026-09-01T14:32:00-05:00",
      "raw_text": "Synthetic payment notification",
      "external_id": null
    }
  ]
}
```

```sh
node scripts/shortcut-backfill.mjs \
  --input=/private/path/messages-2026.json \
  --input=/private/path/another-period.json \
  --inbox-export=/private/path/shortcut-inbox.json \
  --out-dir=/private/path/prepared-2026 \
  --year=2026
```

The second `--input` is optional; repeat it for each period or bank export under the same source. The converter removes identical message-and-receipt-instant overlaps across those files before preparing batches. `--inbox-export` is also optional but should be supplied to omit messages the inbox already has. The source must remain stable across runs; a different source changes the idempotency identity. If the input is an array, supply `--source=sms-manual-backfill`. The output directory must not exist. The script creates it with mode `0700` and writes numbered batch files and an aggregate manifest with mode `0600`. Each batch has at most 25 messages and 128 KiB of JSON. It prints only aggregate counts and never prints the message text. It rejects missing or guessed receipt timestamps and conflicting stable IDs.

The script also accepts the old Scriptable `messages` array of strings. A string beginning with `[Recibido: DD/MM/YYYY HH:mm]` is converted to `received_at` using the original Colombia local time, while the full text stays unchanged to preserve comparison with earlier `sms-bulk` rows. The older Bancolombia string path passed the body without a receipt prefix. Even if that body mentions a purchase date, it does not establish the **SMS receipt timestamp**. Export those messages with explicit `received_at` metadata or add the same verified receipt prefix for every bank. A plain string without this evidence is rejected before any batch is written. Do not replace it with the script run time.

## Export from the existing Shortcut

1. Duplicate the existing historical Shortcut on the iPhone. In the copy, replace its final Scriptable `send-bulk` action with `scripts/export-bulk.js`, passing the **same message list** as its shortcut parameter. The new script returns JSON text to Shortcuts and makes no network request. [Scriptable documents shortcut input](https://docs.scriptable.app/args/) and [text output](https://docs.scriptable.app/script/).
2. Immediately after **Run Script**, add **Save File** (not **Select File** or **Get File**). Set the first **File** input to the **Run Script** output magic variable; the word **File** is the content to save, not the destination or a file that must already exist. If tapping it opens a picker for an existing file, dismiss the picker, turn off **Ask Where to Save** temporarily, select the magic variable from the previous Scriptable action, then turn **Ask Where to Save** back on. A reported Shortcuts UI case required this toggle before the input variable could be selected. [Apple on action input connections](https://support.apple.com/en-euro/guide/shortcuts/apda850ab0e1/ios), [Apple on magic variables](https://support.apple.com/guide/shortcuts/use-variables-apdd02c2780c/ios), [reported Save File picker behavior](https://talk.automators.fm/t/save-text-to-file-overwrite-every-time/14524).
3. Run the copied Shortcut, choose a private destination in Files, and save the new file as `messages-2026.json`. If Shortcuts names the text output `.txt`, keep the content and rename the file in Files before using the converter; the JSON content matters more than the extension. Verify that it begins with `{"source":"sms-manual-backfill","messages":...}`. **Save File** creates the output file; do not choose a pre-existing input file or run the old sender. [Apple lists Save File as a file-management share action](https://support.apple.com/en-gb/guide/shortcuts/apdaf74d75a5/9.0/ios/26).
4. Use the precise corrections below for the supplied Shortcut. Its **Find Messages** action is present in the screenshots, but the current loop drops the message date before calling Scriptable. If the search cannot produce a complete 2026 list, export what it actually finds and compare it with bank statements; never invent missing messages or timestamps.
5. Copy the JSON file to the machine running `scripts/shortcut-backfill.mjs`. The converter will reject any unprefixed legacy strings; correct those in a new source file with the original receipt timestamp before retrying. Keep the input file and generated batches private and do not commit them.

The `--inbox-export` comparison file is needed only after the web inbox is deployed and contains messages. Download it while signed in from `GET /api/shortcut-inbox/export`; an API key alone cannot read this route. Before deployment, omit the option and retain the prepared source file for a later comparison. The inbox itself also treats an unchanged replay as previously received.

## Email-only notifications

The current Worker `/email` route is Bancolombia-specific and can create transactions directly. It is not the historical Lulo credit-card import path. The offline converter accepts a provider-neutral JSON export with a separate source, for example:

```json
{
  "source": "lulo-email-backfill",
  "emails": [
    {
      "message_id": "synthetic-message-001",
      "received_at": "2026-09-20T14:32:00-05:00",
      "from": "Lulo Bank <notifications@example.invalid>",
      "subject": "Synthetic card notice",
      "text": "Synthetic purchase notice, not a real transaction"
    }
  ]
}
```

The adapter preserves sender, subject, and plain text in a bounded inbox item. It uses a stable mail message ID when available and the mailbox receipt instant, not the script run time. It rejects HTML-only or oversized messages until a source-specific extractor is evaluated. Email and SMS use different `source` values; a financial event reported by both channels must still be checked against the existing ledger before creating a row. For Lulo notices in Gmail, use `scripts/export-lulo-gmail.js` and follow `docs/guides/lulo-gmail-backfill.md`; this exporter reads individual messages from each thread and has only been tested with synthetic messages.

Review the generated files, then use the private Shortcut recipe in `spends-assistant-web/docs/guides/ios-shortcut-inbox-backfill.md` to send each unchanged file to the **released** web endpoint. Inspect every per-item response. A successful inbox POST only saves the message; it has no effect on cash balances. For each message, review the web candidate list and link an existing transaction or deliberately create a missing one. Preserve the source file until each message has a verified inbox status.

## Financial guard

Do not bulk-create ledger rows merely because a notice lacks an exact raw-text match. Older CSV or manually entered transactions may represent the same payment with different or absent text. The September 28 audit found 480 CSV rows without an import ID and no complete opening/closing account interval. For each reviewed historic creation, compare source date, amount, direction, account mapping, and existing-transaction candidates. Confirmed missing rows may change the stored balance through the atomic create flow; the owner accepts correcting balances as part of backfill. Check when the stored balance was last changed so an already reflected event is not counted twice. A bank statement is not a prerequisite for the import.

After backfill, reconcile each calendar quarter when Bancolombia's quarterly report arrives, normally about one month after the quarter ends: January–March in April, April–June in July, July–September in October, and October–December in January. Compare opening and closing balances, transaction lines, duplicates, missing notices, and account mapping. Record a dated, reviewed correction if a residual difference remains; do not silently overwrite balances or retroactively duplicate transactions. This cadence is a review plan, not an automated schedule.

The revised Shortcut's date output and completeness have not yet been verified on the target device. Inspect one private exported object before preparing batches: it must contain a full ISO 8601 `received_at` with timezone and the unchanged `raw_text` body. If the Shortcut exports another field layout, adapt this script only after inspecting a small redacted sample and testing that the original timestamp and message text survive unchanged.

## Corrections to the supplied Shortcut

The three private screenshots in `shortcuts/` show that **Find Messages** searches for a body containing the selected bank, applies a lower date bound of January 1, 2026 at **11:10 p.m.**, limits the result to **Read** messages, and loops over the results. Inside the loop, **Text = Body** followed by **Get Text** removes the Messages object's original receipt date. `Repeat Results` therefore reaches `Export spends` as an array of body strings, exactly matching the supplied date-free TXT files. These screenshots show the action configuration, not a verified complete export.

1. Duplicate the Shortcut. In **Find Messages**, set the lower bound to **after December 31, 2025 at 11:59 p.m.** and the upper bound to **before January 1, 2027 at 12:00 a.m.** for the full 2026 calendar year. Remove the **Read** filter so unread notices are included. Keep the bank-body filter initially, but note that it cannot find notifications that omit the bank name from the body.
2. Within **Repeat with Each Message**, replace **Text = Body → Get Text** with: get the **Date** property of **Repeat Item**; apply **Format Date** using **ISO 8601**; get the **Body** property of the same **Repeat Item**; then make a **Dictionary** with text keys `received_at` = formatted date and `raw_text` = unchanged body. Leave **Dictionary** as the last action in the loop. [Apple confirms that Repeat Results gathers the last action's output for each item](https://support.apple.com/en-gw/guide/shortcuts/apdc11deb2c1/ios) and [documents ISO 8601 dates with times and offsets](https://support.apple.com/en-gb/guide/shortcuts/apdfd459e13d/ios).
3. Pass **Repeat Results** to `Export spends` (`scripts/export-bulk.js`), then use **Save File** on the script's text output as above. Export Bancolombia and Nequi separately; leave the old `send-bulk` script unused. Verify a single private object such as `{"received_at":"2026-09-01T14:32:00-05:00","raw_text":"..."}` without sharing its real body. If `Date` or `Body` cannot be selected as a property of **Repeat Item**, use **Get Details of Messages** for that property; confirm the on-device output before the full run.
4. Run `node scripts/shortcut-notice-audit.mjs --input=/private/path/messages.json` for aggregate message-kind counts, then `node scripts/shortcut-backfill.mjs --input=/private/path/messages.json --out-dir=/private/path/prepared-2026 --year=2026`. Both commands run locally. The audit does not send or print bodies; its rules are only a coarse review aid, never authority to create a transaction.

## Owner's September 29 exports

The privately supplied `Bancolombia.txt` contains 500 message strings in UTF-16LE JSON; `Nequi.txt` contains 131 message strings in UTF-8 JSON. The local converter now reads both encodings. Neither export contains a `received_at` value or the legacy `[Recibido: ...]` prefix, so both remain blocked from inbox preparation. The Nequi export has only 46 distinct strings, including repeated promotional messages. These are counts of exported strings, not counts of 2026 financial transactions.

The next Shortcut revision must preserve the original message receipt instant alongside each full message body, for example `{"received_at":"2026-09-01T14:32:00-05:00","raw_text":"..."}`. Keep the two originals private for comparison and rerun the converter only on a timestamped export. A bank event date inside the body is different evidence from the SMS receipt instant and must not be copied into `received_at` without verification.

The local aggregate audit of those exports produced the following **heuristic message-kind counts**. These are neither confirmed 2026 events nor ledger transactions; the files lack receipt timestamps, exact body repeats do not establish duplicate financial events, and the rules can misclassify ambiguous wording.

| Export      | Bodies | Exact distinct bodies | Failed payment | Purchase or payment candidate | Outgoing transfer candidate | Incoming candidate | Security | Marketing | Unknown |
| ----------- | -----: | --------------------: | -------------: | ----------------------------: | --------------------------: | -----------------: | -------: | --------: | ------: |
| Bancolombia |    500 |                   496 |              1 |                           284 |                         150 |                 15 |        8 |         6 |      36 |
| Nequi       |    131 |                    46 |            105 |                            14 |                           0 |                  0 |        0 |         8 |       4 |

The 105 Nequi insufficient-funds notices are especially likely to be mistaken for purchases if a classifier only looks for the verb “pay.” Incoming Bancolombia transfers, internal transfers, card repayments, failed notices, security codes, and marketing need distinct treatment. Before any financial creation, a read-only AI suggestion should classify each inbox item as an actual posted event, incoming money, own-account transfer, card repayment, failed attempt, marketing/security notice, or uncertain; extract evidence with confidence and cite the message text. The owner must compare it with existing rows and account-balance history, then explicitly match, mark non-transaction, or create one reviewed row. Unknown and low-confidence items remain pending. No heuristic or model suggestion should mutate a balance.

## Owner's timestamped September 29 exports

`Bancolombia-01.txt` and `Nequi-01.txt` are private UTF-16LE JSON exports with complete ISO 8601 receipt instants and nonempty message bodies. A converter dry run accepted all 500 Bancolombia and 132 Nequi objects individually. Combined under their shared `sms-manual-backfill` source, the 632 input objects contain five identical message-and-receipt-instant overlaps across the two files, leaving **627 unique inbox items** in 26 bounded batches. These counts do not compare with existing financial rows, and no API or database write was made.

| Export      | Receipt range, Colombia time         | Monthly counts                                | Heuristic failed-payment notices |
| ----------- | ------------------------------------ | --------------------------------------------- | -------------------------------: |
| Bancolombia | 2026-01-01 12:03 to 2026-05-28 11:56 | Jan 87; Feb 76; Mar 114; Apr 124; May 99      |                                1 |
| Nequi       | 2026-02-03 18:05 to 2026-09-28 22:15 | Feb 6; May 17; Jun 28; Jul 34; Aug 37; Sep 10 |                              106 |

The Bancolombia query is sorted oldest first and returned exactly 500 messages, stopping in May although the search upper bound was September 29. That strongly suggests incomplete coverage, but does **not** prove a documented 500-result cap in Messages. [Apple recommends narrower Find filters for broad queries](https://support.apple.com/en-ae/guide/shortcuts/apdbdab3433f/ios). Re-run the same timestamp-preserving Shortcut for Bancolombia in three date windows: January–March, April–June, and July–September 29. Keep the bank-body filter and remove the Read filter. Export each window to a separate private file. If a window again returns 500, split it by month. Overlap at a boundary is safe because the converter deduplicates identical body plus receipt instant. Compare the monthly counts and earliest/latest dates with `scripts/shortcut-notice-audit.mjs`; it now reports those aggregates without printing bodies. Do not post the current partial set as if it covered the year.

On September 29, a separate read-only comparison against the count-confirmed owner profile found **1,516 active ledger rows**, still ending on **2026-09-07**. Of the 627 unique notices, **437 have identical raw text in at least one active ledger row** and **190 do not**. The 190 without identical raw text break down into 107 failed-payment notices, 9 marketing notices, 8 security notices, 34 unknown notices, 21 possible purchases/payments, 7 possible outgoing transfers, and 4 possible incoming transfers. This is a text comparison, not an assertion that the 190 are missing financial rows. CSV or edited rows can represent the same event with different or absent raw text, and some unknown notices may be non-financial. The comparison made only GET requests and did not post the exported SMS content. It is reproducible with:

```sh
node scripts/shortcut-ledger-compare.mjs \
  --input=Bancolombia-01.txt \
  --input=Nequi-01.txt \
  --expected-count=1516
```

The script identifies a unique owner only while exactly one profile has the confirmed active count; it stops if the count changes. Its output is aggregate only. Re-run after the missing Bancolombia windows arrive and before any inbox upload. Even a notice with identical raw text needs owner review before linking, because eight notices currently have more than one identical-raw ledger row. Do not bulk-create the 190 non-identical cases.

## Follow-up Bancolombia export, September 29

The owner supplied `Bancolombia mayo-2.txt`, a private UTF-16LE export with **489** dated message objects from **2026-05-28 05:00:03** through **2026-09-29 13:25:08** Colombia time. The first Bancolombia file ended on May 28 at 11:56:40, and three message-and-instant pairs appear in both Bancolombia files. That verified overlap removes the previously observed date-window gap between the two exports. The follow-up file is below 500 items and reaches the day it was generated. It does not prove that every message was indexed by Shortcuts, that the Read filter was removed, or that a body omitting the bank name could be found by the current query.

The three supplied files contain **1,121** objects. The converter removed ten identical cross-file message-and-instant overlaps, leaving **1,111 unique 2026 inbox items** in **45** batches. It wrote those batches and a manifest locally to the private directory `../backfill-private-2026-09-29` with `0700` directory and `0600` file permissions. The files have not been posted to the web inbox, and the preparation did not use an inbox export, so `already_in_export` is zero by construction.

The live read-only ledger comparison again found **1,516 active rows**. Of the 1,111 unique notices, **789 have identical raw text** in at least one active row and **322 have no identical raw text**. The latter group includes 107 failed-payment notices, 10 marketing notices, 8 security notices, 46 unknown notices, 104 possible purchases/payments, 41 possible outgoing transfers, and 6 possible incoming transfers. These are heuristic review queues, not 322 missing financial events. Eight notices have more than one identical-raw ledger row and require manual link review. Reproduce the aggregate comparison with:

```sh
node scripts/shortcut-ledger-compare.mjs \
  --input=Bancolombia-01.txt \
  --input='Bancolombia mayo-2.txt' \
  --input=Nequi-01.txt \
  --expected-count=1516
```

Next, review the 322 non-identical notices without creating ledger rows: start with failed/security/marketing exclusions, then compare the remaining 197 possible financial or unknown notices against CSV imports, account identity, amount, posting date, and available bank evidence. The 789 exact-text matches should be linked only after checking ambiguous duplicate rows. Check stored account-balance history before historic financial creation, and seek an external balance only for unresolved cases. The private prepared batches are an inbox intake artifact, not an approved transaction import.

## Private AI triage and financial candidates

The 322 notices without an identical or normalized ledger body were exported privately with `scripts/shortcut-ledger-compare.mjs --out-private=...`. `scripts/shortcut-ai-triage.mjs` then sent only those notices to DeepSeek V4.1 Flash through OpenRouter with `provider.zdr: true`, `data_collection: deny`, and reasoning disabled. Each model result was required to cover one known message index and quote an exact substring of that message. Batches were checkpointed in owner-only files, and the final private report is `../backfill-private-2026-09-29/ai-triage-2026-09-29.json`. No Supabase or account write occurred.

The model suggested **155 possible financial notices**: 72 purchases, 71 outgoing transfers, 6 incoming transfers, 5 card payments, and 1 withdrawal. It suggested **167 non-posting or informational notices**: 111 failed attempts, 28 marketing, 15 security, and 13 informational. All 322 evidence excerpts passed exact-substring validation. The successful recorded batches used 40,023 prompt tokens and 25,674 completion tokens with **$0.01824 returned cost**; earlier failed/retried calls and synthetic checks may add cost not included in that figure. The model labeled 320 of 322 notices “high” certainty; this is an uncalibrated model self-report and is not an approval signal. In particular, 28 notices matching the local purchase/payment heuristic were labeled outgoing transfers by the model, so that wording needs manual review before category or type changes.

`scripts/shortcut-candidate-review.mjs` performed another read-only comparison for those 155 possible financial notices. A conservative parser found an explicit amount in 147 and both an amount and a message-stated event date in 116. Across active ledger rows, only **one** notice had a same-amount candidate within three days, and that candidate lacked a verified same-account signal. The remaining 154 have no candidate under these narrow rules; this does not prove that they are missing from the ledger because statement posting dates, account mapping, unparsed wording, or prior edits can differ. The private item-level candidate report is `../backfill-private-2026-09-29/financial-candidates-2026-09-29.json`.

## Outgoing recipient recurrence review

`scripts/shortcut-recipient-review.mjs` groups explicit destinations in outgoing Bancolombia transfer notices from the three dated exports. It reads the count-confirmed owner ledger and categories using GET requests only. Exact raw-text matches provide prior category evidence only when one existing expense row matches; duplicated raw-text matches are ambiguous. The report stays outside Git with owner-only permissions and assigns aliases such as `R001` for discussion. It neither creates transactions nor inserts automation rules.

```sh
node scripts/shortcut-recipient-review.mjs \
  --input=Bancolombia-01.txt \
  --input='Bancolombia mayo-2.txt' \
  --input=Nequi-01.txt \
  --out-private=/private/path/recipient-review.json \
  --expected-count=1516
```

On September 29, 270 of the 1,111 deduplicated notices stated an outgoing transfer. The parser found an explicit destination in all 270, grouped into 124 identifiers. Fourteen groups appeared on at least three distinct event days across at least two months. A starred ten-digit destination beginning with `3` is treated as a complete probable Colombian phone identifier; other starred destinations, including eleven-digit values, remain weak account identifiers. The largest probable-phone groups contained 40 and 24 notices. The first had 31 uniquely matched rows already typed `transfer`, but account ownership remains unverified. The second had 18 uniquely matched expense rows all previously labeled `Restaurant, Fast-food`; another probable-phone group had four of four such rows. These two groups meet the threshold for **review suggestions**, not active rules: the prior labels may themselves need correction, and the owner has not confirmed either recipient. Zero rules were created. The private result is `../backfill-private-2026-09-29/recipient-review-2026-09-29-v4.json`; a shorter owner review table is `../backfill-private-2026-09-29/recurring-destinations-owner-review-2026-09-29.md`.

Review the high-frequency aliases against bank receipts or account details before assigning a person, merchant, own account, or category. An outgoing transfer to the owner's account must be modeled as an internal transfer only after account ownership is verified. `match_phone` rules trigger the transfer processor's internal-transfer flow, so they must never be used to categorize an external Nequi recipient. After owner confirmation, a general rule may match the complete raw destination phrase and source, set a category, and remain inactive until verified on historical and synthetic examples. Time of day and frequency are supporting signals, not sufficient category evidence. The SMS body does not reliably identify the receiving institution, so this report calls them destinations rather than confirmed Nequi accounts.

Review order: confirm the model's non-posting labels, inspect conflicting `pagaste` versus transfer wording, compare dated amounts against existing ledger and CSV rows, inspect stored account-balance history, then decide individually whether to link an existing row or create a missing one. Use available bank receipts or statements for unresolved matches. Review the recurrent destination aliases with the owner before drafting any rules. Do not apply automation rules or financial writes from these suggestions alone.

## Owner-reviewed recipient maintenance

The owner identified the recurrent destinations and approved category rules for rent, a neighborhood supermarket, a mobile bill, personal training, restaurant purchases, motorcycle parking, an ice-cream shop, and motorcycle washing. `scripts/recipient-maintenance.mjs` applies private, owner-scoped plans only after it rechecks the active transaction count, raw-message hash, prior category, amount, type, and update timestamp for each planned row. It also checks active rule collisions and writes an owner-only audit log. The default mode is read-only; `--apply` requires an owner-only audit path. The plans and audit logs live outside Git under `../backfill-private-2026-09-29/`.

Two reviewed plans changed **42 existing expense categories**, inserted **eight general category rules**, and corrected one existing ice-cream rule whose combined keyword could not match the observed messages. The already-active personal Nequi rule matched all 40 reviewed outgoing notices and linked 31 existing ledger rows to the Nequi account; the existing restaurant rule matched all 24 starred-account notices for its recipient. Two additional messages used the same full recipient number as a Bre-B key, so the second plan categorized those two existing rows and added a separate key rule. Post-apply verification found 1,516 active rows, every planned category/rule change, no unplanned transaction field change, and no account-balance change. The two unmatched notices in the first plan remain review items, not created transactions.

The owner confirmed that the barbershop's ten 25,000 COP payments are personal care and the one 3,500 COP payment was a drink; that the two previously uncategorized approximately 46,000 COP transfers to a sibling were gifts; and that the 150,000 COP outgoing transfer to a friend in July was a gift. Mixed-purpose transfers to the sibling were not given a blanket rule. A 2.1 million COP outgoing payment to that friend in April remains a bicycle investment awaiting sale, separate from the March 3 million COP personal loan. The loan principal and repayments require an asset/receivable model and a balance-safe correction; the category-only maintenance did not change their transaction types.

An additional read-only direction audit found **17 rows typed `expense` although their source message says `recibiste`**, including four incoming transfers naming the friend totaling 2.83 million COP. The owner confirmed that all four receipts repaid the March 3 million COP loan: 50,000 COP on May 16, 50,000 COP on June 18, 30,000 COP on August 3, and 2.7 million COP on August 19. The provisional outstanding principal is therefore **170,000 COP**, pending source-statement and account-balance reconciliation. An owner-only repayment schedule with source transaction IDs is `../backfill-private-2026-09-29/kevin-loan-owner-confirmed-2026-09-29.json`. The direction mismatch also includes payroll and other large incoming transfers. Do not patch transaction types through the service-role REST endpoint: that bypasses the atomic balance adjustment and reviewed-edit guards. The owner-only audit is `../backfill-private-2026-09-29/direction-conflict-review-2026-09-29.json`. After the 42 recipient category edits, 273 existing expenses lacked a useful category: 226 had no category and 47 explicitly said `Uncategorized`; ten were at or above 1 million COP. A ledger-wide destination review found 94 destination groups with missing expense categories, including 80 with only one event and three multi-month groups that had not met the original 2026-export recurrence threshold. The private report is `../backfill-private-2026-09-29/ledger-gap-audit-2026-09-29-v3.json`.

The owner then confirmed that a 3.2 million COP July transfer bought dining-room furniture, that two nearly 2.94 million COP transfers to Lulo Bank were installments on a personal loan, and that the 2.7 million COP August receipt from the friend repaid principal. A third private, preconditioned plan changed only the three expense categories, bringing the total to **45 category edits**, eight new rules, and one corrected rule. The furniture uses `Home, Garden`; the two Lulo payments use `Debt Payment` as an interim purpose label, with principal/interest allocation still pending. Neither the loan installments nor the friend's repayment was given a blanket rule or a type/balance patch. A fresh read-only audit found **270** expenses without a useful category, including **seven** at or above 1 million COP. The current private report is `../backfill-private-2026-09-29/ledger-gap-audit-2026-09-29-v4.json`, with an owner review table at `../backfill-private-2026-09-29/ledger-gap-owner-review-2026-09-29-v2.md`.

A final live comparison against the pre-maintenance snapshot confirmed all 45 planned category changes across the same 1,516 transaction IDs, 22 active rules, zero other transaction-field differences, and zero account-balance differences. The seven large uncategorized rows include the 2.7 million COP incoming repayment recorded with the wrong direction, two MercadoPago card purchases (1.60 million and 1.37 million COP), three QR payments whose descriptions contain only the owner's name (1.50 million, 1.465 million, and 1.324 million COP), and a 1.10 million COP outgoing transfer to a destination ending in 1146. None has a defensible automatic category without its underlying purpose. The parser routes generic `transferencia` wording into the outgoing transfer processor and several intake handlers initialize parsed transactions as `expense`; both paths need direction-aware tests and a review state before further historical posting.

## Subsequent owner clarifications

The owner identified ten more expense purposes. A fourth private, preconditioned plan categorized an Apple Watch, a motorcycle CarPlay unit, clothing, two phone-accessory purchases from a cousin, three gifts to a sister-in-law, and two payments toward one refrigerator. These use the existing `Electronics, Accessories`, `Clothes & Footwear`, `Gifts, Joy`, and `Home, Garden` categories. The three gifts did not receive an automation rule because the owner did not want one. The private plan and apply audit are `../backfill-private-2026-09-29/recipient-maintenance-plan-2026-09-29-owner-clarifications.json` and `../backfill-private-2026-09-29/recipient-maintenance-audit-2026-09-29-owner-clarifications.jsonl`.

The 1.5 million COP August 20 QR payment bought USD through Binance P2P; it remains an existing bank leg awaiting investment and FX reconciliation, not an expense-category correction. The 800,000 COP May 5 transfer was a loan to the owner's sibling; it needs a receivable rather than an expense category. The 1.37 million COP July 16 MercadoPago purchase combined motorcycle items and a TP-Link mesh unit; retain it for a source-supported split instead of assigning the whole amount to one purpose. The owner also reports that the friend paid the remaining 170,000 COP in cash. The owner-reported loan balance is therefore zero, but the cash date is unknown and no cash-ledger event or type/balance patch was created. The private repayment schedule records both the four bank receipts and the undated cash settlement.

The final live postcheck found **55** intended category changes across the unchanged 1,516 transaction IDs, 22 active rules, no other transaction-field differences, and no account-balance differences. **260** expenses still lack a useful category; only three are at or above 1 million COP: the misdirected 2.7 million COP incoming repayment, the 1.5 million COP Binance bank leg, and the 1.37 million COP mixed MercadoPago order. The owner-only postcheck is `../backfill-private-2026-09-29/owner-clarifications-postcheck-2026-09-29.json`.

## Remaining-expense evidence review

The owner asked for a gradual review of all remaining rows, using original notices and historical labels before requesting more descriptions. An owner-only, read-only report now lists all **260** rows with aliases, source excerpts, proposed review leads, and a JSON companion containing the full original messages: `../backfill-private-2026-09-29/remaining-expenses-owner-review-2026-09-29.md` and `.json`. Their 27.05 million COP nominal sum is **not** a spending total: the set includes incoming money, a Binance investment leg, loans, and possible duplicate rows.

The remaining rows comprise 107 outgoing-transfer notices, 48 QR payments, 39 card purchases, 31 imported statement-only rows, 20 merchant-payment notices, 11 incoming-worded notices recorded as expenses, and four other notices. Explicit merchant and product text points to six Spotify, six Netflix, seven YouTube, two Google One, one iCloud, and four IGS Multiasiste rows for review. A separate deterministic comparison of same-account, same-description historical labels proposed four high-confidence category reviews: three Spotify rows and one IGS row. Its 63 generic-description and three recurrence review flags are supporting signals, not category decisions; the private proposal file is `../backfill-private-2026-09-29/spends-review-proposals-h5H8sl/proposals.json`. Historical category labels are inconsistent for some digital services; a matching merchant name is stronger evidence than transfer time or amount, but is not proof of the exact product purchased. Six exact raw-message/date/account/amount duplicate groups exist in the complete ledger, representing eight additional rows and 720,413 COP in repeated nominal amounts. The three extra 95,000 COP DHI rows already carry `pending_review`; do not delete or adjust balances before comparing a dated bank statement.

For new suggestions, use the original direction and merchant or destination first, then compare owner-confirmed historical rows on the same account, then source receipts or statements. Treat recurrence and time of day as supporting evidence. Exact public searches for two recurrent transfer-phone identifiers did not yield a credible merchant identity; do not infer a private recipient's identity or purpose from a loose web result. The owner deferred splitting the mixed MercadoPago charge and suggested investigating provider-authorized Mercado Pago and Amazon connections later.

## Owner-confirmed QR merchant and DHI review

The owner identified the QR key ending in 7469 as Carnes Brass and confirmed the DHI merchant identity. A private, preconditioned plan categorized the 13 existing QR rows as `Groceries`; two of those had previously been labeled `Restaurant, Fast-food`, so this changed 11 categories. One active `general` rule now requires both outgoing `pagaste` wording and the complete QR key in the original message before setting `Groceries`. It does not use `match_phone` or create an internal transfer. Three distinct, previously uncategorized DHI charges were placed in `Wellness, Beauty`, consistent with four earlier rows; the three identical January DHI notifications still marked `pending_review` were not categorized or deleted. The category choice for the meat retailer is an owner-context inference and can be revised if receipts establish a different purchase purpose.

The original `Patrimonios Autónomos Administ` messages name only a shortened payment recipient. The owner subsequently identified these payments as the comprehensive insurance for their motorcycle. That owner evidence, rather than the generic payee name alone, supports the `Vehicle Insurance` category.

The first idempotence check exposed an unstable offset-pagination read in `scripts/recipient-maintenance.mjs`: without `order=id.asc`, Supabase returned overlapping 500-row pages and the tool reported a false transaction conflict. A regression test reproduced overlapping pages; the maintenance reader now orders every page by ID. The Carnes Brass/DHI postcheck verified all 1,516 unique transaction IDs, 69 cumulative category changes against the original snapshot, 23 active rules, 13 exact matches for the QR rule, no other transaction-field differences, and no account-balance differences. Private evidence: `../backfill-private-2026-09-29/recipient-maintenance-plan-2026-09-29-carnes-brass-dhi.json`, its matching audit log, and `../backfill-private-2026-09-29/carnes-brass-dhi-postcheck-2026-09-29.json`.

## Owner-confirmed motorcycle insurance and September 7 gap

Five existing payments to the truncated Patrimonios payee (December 22, April 28, May 30, July 11, and August 5) were categorized as `Vehicle Insurance` after the owner identified their purpose. A `general` rule requires the outgoing `pagaste` wording, the specific payee fragment, source account `*2651`, and an 180,000–260,000 COP amount. It matched only those five historical rows. If the premium or account changes, the rule needs review. The rule changes only the category; it cannot create a financial transaction.

The owner's UTF-16 Bancolombia export contains a September 7, 2026, 13:20:56 payment of **200,663 COP** to the same payee from account `*2651`. It appears in private `batch-037.json`, but the live 1,516-row ledger has no same-day matching payment; the only two September 7 ledger rows are unrelated charges of 6,400 and 25,900 COP. The mapped Bancolombia account's last stored balance update was September 7 at 08:04 Bogotá time, before this payment. Its SMS is also distinct from all existing rows. This is a strong backfill candidate that does not require a monthly statement. The remaining work is to confirm the intended account and create it through an idempotent, atomic review flow; the prepared inbox batch has not been posted and the migration-backed confirmation flow is not yet released. Private evidence: `../backfill-private-2026-09-29/september-7-insurance-balance-check-2026-09-29.json`.

The final read-only postcheck verified **74** cumulative category changes from the original snapshot, **24** active rules, five of five existing motorcycle-insurance rows correctly categorized, all 1,516 unique transaction IDs, no other transaction-field differences, and no account-balance differences. **243** expense-typed rows remain without a useful category. Private evidence: `../backfill-private-2026-09-29/recipient-maintenance-plan-2026-09-29-motorcycle-insurance.json`, its matching audit log, `../backfill-private-2026-09-29/motorcycle-insurance-postcheck-2026-09-29.json`, and `../backfill-private-2026-09-29/remaining-expenses-owner-review-2026-09-29-v3.md`.
