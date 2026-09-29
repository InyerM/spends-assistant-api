import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../../scripts/export-lulo-gmail.js', import.meta.url), 'utf8');

function mail(id, from, body, date = '2026-09-25T19:17:00-05:00') {
  return {
    getId: () => id,
    getFrom: () => from,
    getSubject: () => 'Compra realizada',
    getPlainBody: () => body,
    getDate: () => new Date(date)
  };
}

function run(pages) {
  const searches = [];
  const created = [];
  const context = {
    Utilities: {
      formatDate(date, timeZone, pattern) {
        assert.equal(pattern, 'yyyy');
        return new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(date);
      }
    },
    GmailApp: {
      search(query, start, max) {
        searches.push({ query, start, max });
        return pages[start / max] ?? [];
      },
      getMessagesForThreads(threads) {
        return threads.map((thread) => thread.messages);
      }
    },
    DriveApp: {
      createFile(name, content, mimeType) {
        created.push({ name, content, mimeType });
        return { getName: () => name };
      }
    }
  };
  vm.runInNewContext(code, context);
  const result = context.exportLulo2026();
  return { result, searches, created };
}

test('exports each Lulo message in a Gmail thread, including a zero-amount notice', () => {
  const threads = [
    {
      messages: [
        mail(
          'first',
          'Notificaciones Lulo bank <notificaciones@lulobank.com>',
          'Synthetic $0 notice'
        ),
        mail('second', 'notificaciones@lulobank.com', 'Synthetic COP purchase')
      ]
    }
  ];
  const { searches, created } = run([threads]);
  assert.equal(created.length, 1);
  assert.equal(created[0].mimeType, 'application/json');
  assert.match(searches[0].query, /from:notificaciones@lulobank\.com/);
  const payload = JSON.parse(created[0].content);
  assert.equal(payload.source, 'lulo-email-backfill');
  assert.deepEqual(
    payload.emails.map((email) => email.message_id),
    ['first', 'second']
  );
  assert.equal(payload.emails[0].text, 'Synthetic $0 notice');
  assert.equal(payload.emails[0].received_at, '2026-09-26T00:17:00.000Z');
});

test('filters other senders and messages outside the Colombia 2026 year', () => {
  const threads = [
    {
      messages: [
        mail('other', 'notices@example.invalid', 'Synthetic unrelated notice'),
        mail('old', 'notificaciones@lulobank.com', 'Older', '2025-12-31T23:59:00-05:00'),
        mail('valid', 'notificaciones@lulobank.com', 'Current', '2026-01-01T00:01:00-05:00')
      ]
    }
  ];
  const { created } = run([threads]);
  const payload = JSON.parse(created[0].content);
  assert.deepEqual(
    payload.emails.map((email) => email.message_id),
    ['valid']
  );
});

test('an empty or oversized export fails before writing a Drive file', () => {
  assert.throws(() => run([[]]), /No Lulo messages found/);
  const threads = [{ messages: [mail('large', 'notificaciones@lulobank.com', 'a'.repeat(4097))] }];
  assert.throws(() => run([threads]), /message exceeds inbox limit/);
});
