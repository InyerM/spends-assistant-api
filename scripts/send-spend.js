// Spends Assistant - SMS Forwarder                                                                                                                            
// Scriptable Script            
// ──────────────────────────────                                                                                                                              
// Receives SMS text as input from iOS Shortcuts                                                                                                               
// and sends it to the Cloudflare Worker /transaction endpoint.

const WORKER_URL = "https://expense-assistant.TU-SUBDOMAIN.workers.dev";
const API_KEY = "TU_API_KEY_AQUI";

const input = args.shortcutParameter;

if (!input) {
  Script.setShortcutOutput("Error: No text received from Shortcut");
  Script.complete();
}

const body = {
  text: input,
  source: "sms-shortcut"
};

const req = new Request(`${WORKER_URL}/transaction`);
req.method = "POST";
req.headers = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${API_KEY}`
};
req.body = JSON.stringify(body);

try {
  const res = await req.loadJSON();

  if (res.error) {
    Script.setShortcutOutput(`Error: ${res.error}`);
  } else {
    const tx = res.transaction;
    const amount = tx?.amount?.toLocaleString("es-CO") ?? "?";
    Script.setShortcutOutput(`${tx?.description ?? "Transaction"} - $${amount}`);
  }
} catch (e) {
  Script.setShortcutOutput(`Error: ${e.message}`);
}

Script.complete();