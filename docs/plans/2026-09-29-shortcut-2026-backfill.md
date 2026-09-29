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
  --inbox-export=/private/path/shortcut-inbox.json \
  --out-dir=/private/path/prepared-2026 \
  --year=2026
```

`--inbox-export` is optional but should be supplied to omit messages the inbox already has. The source must remain stable across runs; a different source changes the idempotency identity. If the input is an array, supply `--source=sms-manual-backfill`. The output directory must not exist. The script creates it with mode `0700` and writes numbered batch files and an aggregate manifest with mode `0600`. Each batch has at most 25 messages and 128 KiB of JSON. It prints only aggregate counts and never prints the message text. It rejects missing or guessed receipt timestamps and conflicting stable IDs.

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

Do not bulk-create ledger rows merely because the inbox export lacks a message. Older CSV or manually entered transactions may represent the same payment without matching raw text. The September 28 audit found 480 CSV rows without an import ID and no reconciled opening/closing account interval. Before adding historic financial rows, establish a dated bank-statement balance per affected account and decide whether those older payments already contributed to its stored balance. The current reviewed create flow changes the account balance when it creates a transaction.

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

The 105 Nequi insufficient-funds notices are especially likely to be mistaken for purchases if a classifier only looks for the verb “pay.” Incoming Bancolombia transfers, internal transfers, card repayments, failed notices, security codes, and marketing need distinct treatment. Before any financial creation, a read-only AI suggestion should classify each inbox item as an actual posted event, incoming money, own-account transfer, card repayment, failed attempt, marketing/security notice, or uncertain; extract evidence with confidence and cite the message text. The owner must compare it with existing rows and bank-statement balances, then explicitly match, mark non-transaction, or create one reviewed row. Unknown and low-confidence items remain pending. No heuristic or model suggestion should mutate a balance.
