// Copy this file into a private Google Apps Script project and run exportLulo2026.
// It reads each Lulo Gmail message and creates one JSON file in the user's Drive.
// It does not send mail, call Spends, or create financial transactions.

function exportLulo2026() {
  const sender = 'notificaciones@lulobank.com';
  const query = `from:${sender} after:2025/12/30 before:2027/01/03`;
  const pageSize = 100;
  const maxThreads = 500;
  const maxMessages = 500;
  const messages = [];
  const seenIds = new Set();

  for (let start = 0; start <= maxThreads; start += pageSize) {
    const threads = GmailApp.search(query, start, pageSize);
    if (start === maxThreads && threads.length) {
      throw new Error('Too many Lulo threads; narrow the date range before exporting');
    }
    for (const threadMessages of GmailApp.getMessagesForThreads(threads)) {
      for (const message of threadMessages) {
        const from = message.getFrom();
        const address = (/<([^<>]+)>$/u.exec(from)?.[1] ?? from).trim().toLowerCase();
        if (address !== sender) continue;
        const date = message.getDate();
        if (Utilities.formatDate(date, 'America/Bogota', 'yyyy') !== '2026') continue;
        const id = message.getId();
        if (seenIds.has(id)) continue;
        const subject = message.getSubject();
        const text = message.getPlainBody();
        if (typeof text !== 'string' || !text.trim()) {
          throw new Error('A Lulo message has no plain text body');
        }
        const rawText = `From: ${from.replace(/\s+/gu, ' ').trim()}\nSubject: ${subject.replace(/\s+/gu, ' ').trim()}\n\n${text}`;
        if (rawText.length > 4096) {
          throw new Error('A Lulo message exceeds inbox limit; review it separately');
        }
        messages.push({
          message_id: id,
          received_at: date.toISOString(),
          from,
          subject,
          text
        });
        seenIds.add(id);
        if (messages.length > maxMessages) {
          throw new Error('Too many Lulo messages; narrow the date range before exporting');
        }
      }
    }
    if (threads.length < pageSize) break;
  }

  if (messages.length === 0) throw new Error('No Lulo messages found for 2026');
  messages.sort(
    (first, second) =>
      first.received_at.localeCompare(second.received_at) ||
      first.message_id.localeCompare(second.message_id)
  );
  const payload = JSON.stringify({ source: 'lulo-email-backfill', emails: messages });
  const name = `lulo-emails-2026-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`;
  DriveApp.createFile(name, payload, 'application/json');
  return `Created ${name} with ${messages.length} individual messages`;
}
