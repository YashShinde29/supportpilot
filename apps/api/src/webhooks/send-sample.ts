import { createHmac, randomUUID } from "node:crypto";
import type { IncomingMessageEvent } from "./schema.js";

async function main() {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) throw new Error("Webhook secret is not configured.");
  const event: IncomingMessageEvent = {
    event_id: `evt_${randomUUID()}`,
    type: "message.received",
    brand_id: "verdant-co",
    timestamp: new Date().toISOString(),
    customer: { id: "cust_1042", name: "Aisha Khan", phone: "+919800000001" },
    message: {
      id: `msg_${randomUUID()}`, type: "text",
      text: "Hi, my order #4471 hasn't arrived yet. Can I change the delivery address?",
    },
  };
  const body = JSON.stringify(event);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const url = process.env.WEBHOOK_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3001"}/webhook`;
  // Send identical bytes twice to demonstrate a successful retry without duplicates.
  for (const label of ["First delivery", "Exact retry"]) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": signature },
      body,
      signal: AbortSignal.timeout(35_000),
    });
    console.log(`${label}: HTTP ${response.status}`, await response.json());
    if (!response.ok) { process.exitCode = 1; return; }
  }
}

main().catch(() => {
  console.error("Could not send the sample. Check WEBHOOK_SECRET and ensure the API is running at WEBHOOK_URL (default: local API port).");
  process.exitCode = 1;
});
