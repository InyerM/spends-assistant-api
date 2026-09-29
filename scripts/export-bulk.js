// Scriptable companion for exporting Shortcut SMS input to a private JSON file.
// Replace the old send-bulk Scriptable action with this script, then use the
// Shortcuts "Save File" action on its text output. This script makes no request.

const input = args.shortcutParameter;
const messages = Array.isArray(input)
  ? input
  : typeof input === 'string'
    ? [input]
    : input && Array.isArray(input.messages)
      ? input.messages
      : null;

if (
  !messages ||
  messages.length === 0 ||
  messages.some(
    (message) =>
      !(typeof message === 'string' && message.trim()) &&
      !(
        message &&
        typeof message === 'object' &&
        typeof message.raw_text === 'string' &&
        message.raw_text.trim()
      )
  )
) {
  Script.setShortcutOutput('Error: Input must contain nonempty message strings or objects');
} else {
  Script.setShortcutOutput(JSON.stringify({ source: 'sms-manual-backfill', messages }));
}

Script.complete();
