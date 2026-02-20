// Spends Assistant - Bulk SMS Regression
// Scriptable Script
// ──────────────────────────────
// Receives an array of SMS text strings from iOS Shortcuts
// and sends them in batches to the Cloudflare Worker /transaction endpoint.
//
// Input: ["Bancolombia: Compraste...", "[Recibido: 15/11/2025 14:30] Nequi: Pagaste..."]
//
// For Bancolombia: Shortcut passes body as-is (already has dates).
// For Nequi: Shortcut prepends [Recibido: date] before adding to the list.

const WORKER_URL = "https://expense-assistant.inyer-spends-assistant.workers.dev";
const API_KEY = "YOUR_API_KEY";
const CONCURRENCY = 10;
const DELAY_MS = 1000;

async function main() {
  const raw = args.shortcutParameter;

  // Handle input: could be array of strings, single string, or something else
  let messages = [];
  if (Array.isArray(raw)) {
    messages = raw;
  } else if (typeof raw === "string") {
    messages = raw.split("\n").filter(line => line.trim().length > 0);
  } else if (raw && typeof raw === "object") {
    messages = raw.messages || Object.values(raw);
  }

  if (messages.length === 0) {
    return `Error: No messages. Type: ${typeof raw}, value: ${JSON.stringify(raw).substring(0, 200)}`;
  }

  let success = 0;
  let skipped = 0;
  let errors = 0;

  const batches = chunk(messages, CONCURRENCY);

  for (let i = 0; i < batches.length; i++) {
    const results = await Promise.all(batches[i].map(sendOne));

    for (const r of results) {
      if (r === "success") success++;
      else if (r === "skipped") skipped++;
      else errors++;
    }

    if (i < batches.length - 1) {
      await delay(DELAY_MS);
    }
  }

  return `${messages.length} procesados: ${success} transacciones, ${skipped} skipped, ${errors} errores`;
}

async function sendOne(text) {
  const req = new Request(`${WORKER_URL}/transaction`);
  req.method = "POST";
  req.headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${API_KEY}`
  };
  req.body = JSON.stringify({ text, source: "sms-bulk" });

  try {
    const res = await req.loadJSON();
    if (res.error) return "error";
    if (res.status === "skipped") return "skipped";
    return "success";
  } catch (e) {
    return "error";
  }
}

function delay(ms) {
  return new Promise(resolve => Timer.schedule(ms / 1000, false, resolve));
}

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

try {
  const result = await main();
  Script.setShortcutOutput(result);
} catch (e) {
  Script.setShortcutOutput(`Error: ${e.message}`);
}

Script.complete();
