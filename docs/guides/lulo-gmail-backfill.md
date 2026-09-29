# Export Lulo Bank Gmail notices for reviewed backfill

Status: local script tested with invented messages. It has not run in the owner's Gmail account or sent anything to Spends. The supplied Gmail PDF is a print of a thread containing two separate notices, including a zero-amount notice; use Gmail message IDs rather than the thread PDF as the backfill unit.

## Export from Gmail

1. In Gmail, search `from:notificaciones@lulobank.com after:2025/12/30 before:2027/01/03` and inspect the sender and date range. Gmail supports `from:`, `after:`, and `before:` search operators. The wider date window is intentional: the script applies a second filter to the 2026 calendar year in America/Bogota. [Gmail search operators](https://support.google.com/mail/answer/7190?hl=en).
2. Open [Google Apps Script](https://script.google.com/), create a private project, paste the contents of `scripts/export-lulo-gmail.js` into `Code.gs`, and run `exportLulo2026`. Approve the Gmail and Drive permissions shown by Google. The script uses paged Gmail search and reads each message's ID, date, sender, subject, and plain body; it does not send email or call an external endpoint. [GmailApp search](https://developers.google.com/apps-script/reference/gmail/gmail-app), [GmailMessage fields](https://developers.google.com/apps-script/reference/gmail/gmail-message).
3. The script creates a `lulo-emails-2026-...json` file in the root of your private Drive. Download it to a private local folder. It leaves Gmail messages unchanged and returns only the filename and message count. Google documents `DriveApp.createFile` as a Drive-root write. [DriveApp](https://developers.google.com/apps-script/reference/drive/drive-app).
4. Run the local converter to prepare bounded review batches. Choose a new output directory each time:

```sh
node scripts/shortcut-backfill.mjs \
  --input=/private/path/lulo-emails-2026.json \
  --out-dir=/private/path/prepared-lulo-2026 \
  --year=2026
```

The resulting `batch-*.json` files target the reviewed inbox contract. Do not send them until the web route and database migrations are deployed and checked with synthetic data. The converter does not create expenses, credit-card payments, or loan entries. Save the original export for replay and compare each candidate with card statements and existing ledger rows before a financial decision.

## Boundaries

The script searches the sender address visible in the supplied PDF and independently checks each message inside a matched Gmail thread. It keeps a zero-amount notice as evidence; reviewers should not create a zero-amount card purchase. It fails before writing a file if a message has no plain body, exceeds the inbox's 4,096-character text limit, or the export exceeds its bounded message/thread count. A partial export is not silently labeled complete. If Gmail presents a different sender, a longer body, or another Lulo notice format, review a small redacted sample and adapt the extractor before rerunning.

Gmail's `getDate()` supplies the message timestamp recorded by Apps Script. The bank event date and time in the email body remain separate evidence and must be checked against the card statement. The existing `/email` Worker route handles Bancolombia directly and must not receive this historical Lulo export.
