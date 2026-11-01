import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readDatabaseConfig } from "../apps/api/dist/db/config.js";
import { createDatabaseConnection } from "../apps/api/dist/db/connection.js";
import { initializeModels } from "../apps/api/dist/db/models.js";

// Run with the API/Neon env files loaded. Leaves one fictional conversation
// message and an approved reply so the result can be reviewed in the app.
const base = process.env.SMOKE_API_URL ?? "http://127.0.0.1:4101";
const origin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
let cookie = "";
let step = "environment";
async function request(path, body, authenticated = false) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin, ...(authenticated ? { cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(35000),
  });
  const data = response.status === 204 ? null : await response.json();
  assert.ok(response.ok, `HTTP ${response.status}`);
  return { response, data };
}

async function main() {
  assert.ok(process.env.DATABASE_URL && process.env.AGENT_EMAIL && process.env.AGENT_PASSWORD);
  step = "health";
  assert.equal((await request("/health")).data.status, "ok");
  console.log("PASS: running Fastify health check");
  step = "customer message and Gemini draft";
  const payload = { customerId: "demo_meera", clientMessageId: randomUUID(), timestamp: new Date().toISOString(), text: "Are your products vegan and fragrance-free?" };
  const sent = await request("/customer/messages", payload);
  const duplicate = await request("/customer/messages", payload);
  assert.equal(duplicate.data.messageId, sent.data.messageId);
  assert.equal(duplicate.data.status, "duplicate");
  console.log("PASS: public intake and duplicate submission");
  step = "agent login";
  const login = await request("/auth/login", { email: process.env.AGENT_EMAIL, password: process.env.AGENT_PASSWORD });
  cookie = login.response.headers.get("set-cookie").split(";")[0];
  assert.ok((await request("/auth/me", undefined, true)).data.agent.id);
  step = "real Gemini draft";
  const thread = (await request(`/agent/conversations/${sent.data.conversationId}`, undefined, true)).data;
  const message = thread.messages.find((item) => item.id === sent.data.messageId);
  assert.equal(message.draft.status, "ready", message.draft.errorCode ?? "Draft not ready");
  assert.ok(message.draft.text.trim());
  console.log("PASS: agent login and real Gemini draft stored");
  step = "draft privacy";
  const before = (await request("/customer/conversations/demo_meera")).data.messages;
  assert.ok(before.every((item) => !("draft" in item)));
  assert.ok(!before.some((item) => item.replyToMessageId === sent.data.messageId));
  step = "approval and customer visibility";
  const approvedText = "Yes, all Verdant & Co products are vegan and fragrance-free.";
  const approved = await request(`/agent/drafts/${message.draft.id}/approve`, { text: approvedText }, true);
  const after = (await request("/customer/conversations/demo_meera")).data.messages;
  assert.ok(after.some((item) => item.replyToMessageId === sent.data.messageId && item.text === approvedText));
  console.log("PASS: draft stays private until approval; customer sees edited reply linked to its question");
  step = "independent Neon persistence check";
  const db = createDatabaseConnection(readDatabaseConfig());
  const { Message, Draft } = initializeModels(db);
  try {
    assert.ok(await Message.findByPk(sent.data.messageId));
    assert.equal((await Message.findByPk(approved.data.reply.id)).text, approvedText);
    assert.equal((await Draft.findByPk(message.draft.id)).status, "used");
    // PgBouncer terminates client TLS; pg_stat_ssl describes a different hop.
    const connection = await db.connectionManager.getConnection();
    try {
      assert.equal(connection.connection.stream.encrypted, true);
      assert.equal(connection.connection.stream.authorized, true);
    } finally { await db.connectionManager.releaseConnection(connection); }
    console.log("PASS: incoming message, approved reply and used draft persisted in Neon over TLS");
  } finally { await db.close(); }
}

try { await main(); }
catch { console.error(`FAIL: ${step}. Credentials and provider responses omitted.`); process.exitCode = 1; }
finally {
  if (cookie) {
    try { await request("/auth/logout", {}, true); console.log("PASS: logout"); }
    catch { console.error("FAIL: logout"); process.exitCode = 1; }
  }
}
