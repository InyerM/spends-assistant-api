// Spends Assistant - Bulk SMS Regression
// Scriptable Script
// ──────────────────────────────
// Receives an array of SMS texts from iOS Shortcuts
// and sends them in batches to the Cloudflare Worker /transaction endpoint.
// Designed for date-range regressions (~150 messages).

const WORKER_URL = "https://expense-assistant.TU-SUBDOMAIN.workers.dev";
const API_KEY = "TU_API_KEY_AQUI";
const CONCURRENCY = 5;
const DELAY_MS = 2000;

const messages = args.shortcutParameter;

if (!messages || !Array.isArray(messages) || messages.length === 0) {
  Script.setShortcutOutput("Error: Expected an array of SMS texts");
  Script.complete();
}

function delay(ms) {
  return new Promise(resolve => Timer.schedule(ms, false, resolve));
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
  } catch {
    return "error";
  }
}

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
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

const total = messages.length;
Script.setShortcutOutput(`${total} procesados: ${success} transacciones, ${skipped} skipped, ${errors} errores`);
Script.complete();
