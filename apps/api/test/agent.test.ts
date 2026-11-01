import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { buildApp } from "../src/build-app.js";
import { createDatabaseConnection } from "../src/db/connection.js";
import { readDatabaseConfig } from "../src/db/config.js";
import { createMigrator } from "../src/db/migrator.js";
import { Agent, AgentSession, Conversation, Draft, Message } from "../src/db/models.js";
import { hashPassword } from "../src/auth/passwords.js";
import { hashSessionToken } from "../src/auth/sessions.js";
import { checkLoginLimit } from "../src/auth/throttle.js";
import { ingestMessage } from "../src/messages/ingest.js";
import { receiveMessage } from "../src/messages/receive.js";
import type { IncomingMessageEvent } from "../src/webhooks/schema.js";

test("agent authentication and approval with PostgreSQL", { timeout: 60_000 }, async (t) => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const origin = "https://supportpilot.example";
  const config = readDatabaseConfig(process.env, true);
  const admin = createDatabaseConnection(config);
  const schema = `agent_test_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^agent_test_[a-f0-9]{32}$/);
  const db = createDatabaseConnection(config, schema);
  db.addHook("afterConnect", async (connection) => {
    await (connection as { query: (sql: string) => Promise<unknown> }).query(`SET search_path TO "${schema}"`);
  });
  let providerCalls = 0;
  const provider = async () => { providerCalls++; return "Original generated draft."; };
  const app = buildApp({ db, logger: false, webhookSecret: randomUUID(), draftProvider: provider, webOrigin: origin });
  let created = false;
  const password = randomBytes(24).toString("base64url");
  const email = `agent-${randomUUID()}@example.invalid`;
  const event = (): IncomingMessageEvent => ({
    event_id: `evt_${randomUUID()}`, type: "message.received", brand_id: "verdant-co",
    timestamp: "2026-11-03T10:15:22Z",
    customer: { id: `cust_${randomUUID()}`, name: "Test Customer", phone: "+919800000001" },
    message: { id: `msg_${randomUUID()}`, type: "text", text: "What is your return policy?" },
  });
  const login = (loginEmail = email, loginPassword = password, cookie?: string) => app.inject({
    method: "POST", url: "/auth/login", payload: { email: loginEmail, password: loginPassword },
    headers: { origin, ...(cookie ? { cookie } : {}) },
  });
  let sessionCookie = "";
  const protectedGet = (url: string) => app.inject({ method: "GET", url, headers: { cookie: sessionCookie } });
  const approve = (id: string, text: string) => app.inject({
    method: "POST", url: `/agent/drafts/${id}/approve`, payload: { text }, headers: { origin, cookie: sessionCookie },
  });
  const cookieFrom = (response: { headers: Record<string, unknown> }) => String(response.headers["set-cookie"]).split(";")[0]!;

  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await createMigrator(db, schema).up();
    await app.ready();
    const agent = await Agent.create({ email, name: "Test Agent", passwordHash: await hashPassword(password) });
    const first = (await receiveMessage(db, event(), provider)).message;
    const second = (await receiveMessage(db, event(), provider)).message;
    const firstDraft = (await Draft.findOne({ where: { messageId: first.messageId } }))!;

    await t.test("private endpoints reject anonymous and forged sessions", async () => {
      for (const url of ["/auth/me", "/agent/conversations", `/agent/conversations/${first.conversationId}`]) {
        assert.equal((await app.inject({ url })).statusCode, 401);
      }
      assert.equal((await app.inject({ method: "POST", url: `/agent/drafts/${firstDraft.id}/approve`, headers: { origin }, payload: { text: "Reply" } })).statusCode, 401);
      const forged = `__Host-supportpilot_session=${randomBytes(32).toString("base64url")}`;
      assert.equal((await app.inject({ url: "/auth/me", headers: { cookie: forged } })).statusCode, 401);
    });

    await t.test("login requires the correct origin and conceals account existence", async () => {
      const absentOrigin = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
      assert.equal(absentOrigin.statusCode, 403);
      const badOrigin = await app.inject({ method: "POST", url: "/auth/login", headers: { origin: "https://attacker.example" }, payload: { email, password } });
      assert.equal(badOrigin.statusCode, 403);
      const wrong = await login(email, "incorrect password");
      const unknown = await login(`unknown-${randomUUID()}@example.invalid`, password);
      assert.equal(wrong.statusCode, 401);
      assert.equal(unknown.statusCode, 401);
      assert.deepEqual(wrong.json().error, unknown.json().error);
      assert.equal(await AgentSession.count(), 0);
    });

    await t.test("login sets a secure HTTP-only cookie and stores only its hash", async () => {
      const response = await login(email.toUpperCase());
      assert.equal(response.statusCode, 200, response.body);
      const setCookie = String(response.headers["set-cookie"]);
      assert.match(setCookie, /^__Host-supportpilot_session=/);
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /Secure/i);
      assert.match(setCookie, /SameSite=Lax/i);
      assert.match(setCookie, /Path=\//i);
      assert.ok(!/Domain=/i.test(setCookie));
      sessionCookie = cookieFrom(response);
      const token = sessionCookie.split("=")[1]!;
      const stored = await AgentSession.findOne({ where: { agentId: agent.id } });
      assert.equal(stored?.tokenHash, hashSessionToken(token));
      assert.notEqual(stored?.tokenHash, token);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.deepEqual(Object.keys(response.json().agent).sort(), ["email", "id", "name"]);
      assert.ok(!response.body.includes(password));
      assert.ok(!response.body.includes(token));
      assert.equal((await protectedGet("/auth/me")).json().agent.id, agent.id);
    });

    await t.test("conversations are paginated, ordered, and contain safe draft projections", async () => {
      const list = await protectedGet("/agent/conversations?limit=1&offset=0");
      assert.equal(list.statusCode, 200, list.body);
      assert.equal(list.json().total, 2);
      assert.equal(list.json().items.length, 1);
      assert.equal(list.json().items[0].id, second.conversationId);
      assert.equal(list.json().items[0].latestMessage.sender, "customer");
      const detail = await protectedGet(`/agent/conversations/${first.conversationId}`);
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json().messages[0].draft.text, "Original generated draft.");
      assert.ok(!detail.body.includes("generationToken"));
      assert.ok(!detail.body.includes("passwordHash"));
      assert.equal(detail.headers["cache-control"], "no-store");
      assert.equal((await protectedGet("/agent/conversations?limit=1000")).statusCode, 400);
      assert.equal((await protectedGet("/agent/conversations/not-a-uuid")).statusCode, 400);
      assert.equal((await protectedGet(`/agent/conversations/${randomUUID()}`)).statusCode, 404);
    });

    await t.test("approval rejects cross-origin and invalid requests", async () => {
      const response = await app.inject({ method: "POST", url: `/agent/drafts/${firstDraft.id}/approve`,
        payload: { text: "Forged reply" }, headers: { cookie: sessionCookie, origin: "https://attacker.example" } });
      assert.equal(response.statusCode, 403);
      assert.equal((await approve(firstDraft.id, " \n")).statusCode, 400);
      assert.equal((await approve(firstDraft.id, "x".repeat(4_001))).statusCode, 400);
      assert.equal(await Message.count({ where: { sender: "agent" } }), 0);
    });

    await t.test("concurrent approval saves one edited reply and marks the original draft used", async () => {
      const responses = await Promise.all([approve(firstDraft.id, "Edited by the agent."), approve(firstDraft.id, "Edited by the agent.")]);
      assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 201]);
      assert.equal(responses[0]!.json().reply.id, responses[1]!.json().reply.id);
      const messages = await Message.findAll({ where: { replyToMessageId: first.messageId } });
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.text, "Edited by the agent.");
      assert.equal(messages[0]?.agentId, agent.id);
      await firstDraft.reload();
      assert.equal(firstDraft.status, "used");
      assert.ok(firstDraft.usedAt);
      assert.equal(firstDraft.text, "Original generated draft.");
      const detail = (await protectedGet(`/agent/conversations/${first.conversationId}`)).json();
      assert.deepEqual(detail.messages.map((m: { sender: string }) => m.sender), ["customer", "agent"]);
      const list = (await protectedGet("/agent/conversations")).json();
      assert.equal(list.items[0].id, first.conversationId);
      assert.equal(list.items[0].latestMessage.text, "Edited by the agent.");
      assert.equal((await approve(firstDraft.id, "Different second approval")).statusCode, 409);
      assert.equal(await Message.count({ where: { replyToMessageId: first.messageId } }), 1);
    });

    await t.test("pending and failed drafts cannot be approved; authenticated retry recovers them", async () => {
      const input = await ingestMessage(db, event());
      const draft = (await Draft.findOne({ where: { messageId: input.messageId } }))!;
      assert.equal((await approve(draft.id, "Premature reply")).statusCode, 409);
      await draft.update({ status: "failed", errorCode: "RATE_LIMITED" });
      assert.equal((await approve(draft.id, "Premature reply")).statusCode, 409);
      const route = `/agent/drafts/${draft.id}/retry`;
      const before = providerCalls;
      assert.equal((await app.inject({ method: "POST", url: route, headers: { origin } })).statusCode, 401);
      assert.equal(providerCalls, before);
      const result = await app.inject({ method: "POST", url: route, headers: { origin, cookie: sessionCookie } });
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().draft.status, "ready");
      assert.equal(providerCalls, before + 1);
      assert.equal((await app.inject({ method: "POST", url: route, headers: { origin, cookie: sessionCookie } })).statusCode, 409);
    });

    await t.test("approval failure rolls back the reply, draft state, and activity", async () => {
      const draft = (await Draft.findOne({ where: { messageId: second.messageId } }))!;
      const before = (await Conversation.findByPk(second.conversationId))!.lastActivityAt.getTime();
      Draft.addHook("beforeUpdate", "simulate-approval-failure", (value) => {
        if (value.get("id") === draft.id && value.get("status") === "used") throw new Error("Private test failure");
      });
      try {
        const response = await approve(draft.id, "Should roll back");
        assert.equal(response.statusCode, 500);
        assert.ok(!response.body.includes("Private test failure"));
      } finally {
        Draft.removeHook("beforeUpdate", "simulate-approval-failure");
      }
      assert.equal(await Message.count({ where: { replyToMessageId: second.messageId } }), 0);
      assert.equal((await draft.reload()).status, "ready");
      assert.equal((await Conversation.findByPk(second.conversationId))!.lastActivityAt.getTime(), before);
      assert.equal((await approve(draft.id, "Successful retry")).statusCode, 201);
    });

    await t.test("public demo intake shares ingestion, deduplicates and exposes only approved replies", async () => {
      const presets = (await app.inject({ url: "/customer/customers" })).json().customers;
      assert.equal(presets.length, 3);
      const payload = { customerId: presets[0].id, clientMessageId: randomUUID(), timestamp: new Date().toISOString(), text: "Can I return an unopened item?" };
      const send = () => app.inject({ method: "POST", url: "/customer/messages", headers: { origin }, payload });
      assert.equal((await app.inject({ method: "POST", url: "/customer/messages", payload })).statusCode, 403);
      assert.equal((await app.inject({ method: "POST", url: "/customer/messages", headers: { origin }, payload: { ...payload, customerId: "private_customer" } })).statusCode, 400);
      assert.equal((await app.inject({ url: "/customer/conversations/private_customer" })).statusCode, 400);
      const callsBefore = providerCalls;
      const sent = await send();
      assert.equal(sent.statusCode, 201, sent.body);
      assert.equal((await send()).statusCode, 200);
      assert.equal(providerCalls, callsBefore + 1);
      const url = `/customer/conversations/${payload.customerId}`;
      const before = (await app.inject({ url })).json();
      assert.equal(before.messages.length, 1);
      assert.equal(before.messages[0].text, payload.text);
      assert.equal("draft" in before.messages[0], false);
      assert.equal(JSON.stringify(before).includes("Original generated draft"), false);
      const draft = (await Draft.findOne({ where: { messageId: sent.json().messageId } }))!;
      const approved = await approve(draft.id, "Your unopened item may be returned within seven days.");
      assert.equal(approved.statusCode, 201, approved.body);
      const after = (await app.inject({ url })).json();
      assert.equal(after.messages.length, 2);
      assert.equal(after.messages[1].sender, "agent");
      assert.equal(after.messages[1].text, "Your unopened item may be returned within seven days.");
      assert.equal(after.messages.some((message: object) => "draft" in message), false);
      assert.equal((await app.inject({ url: `/customer/conversations/${presets[1].id}` })).json().total, 0);
    });

    await t.test("login limits are stored in PostgreSQL and reset after the window", async () => {
      const address = `limited-${randomUUID()}@example.invalid`;
      for (let i = 0; i < 10; i++) await checkLoginLimit(db, address);
      const response = await login(address, password);
      assert.equal(response.statusCode, 429);
      assert.equal(response.json().error.code, "LOGIN_LIMIT");
      await db.query("UPDATE login_attempts SET window_started_at = CURRENT_TIMESTAMP - INTERVAL '16 minutes' WHERE key_hash = $1", {
        bind: [createHash("sha256").update(address).digest("hex")],
      });
      assert.equal((await login(address, password)).statusCode, 401);
    });

    await t.test("login rotates sessions; expired sessions and logged-out cookies are rejected", async () => {
      const oldCookie = sessionCookie;
      const replacement = await login(email, password, oldCookie);
      assert.equal(replacement.statusCode, 200);
      sessionCookie = cookieFrom(replacement);
      assert.notEqual(sessionCookie, oldCookie);
      assert.equal((await app.inject({ url: "/auth/me", headers: { cookie: oldCookie } })).statusCode, 401);
      const token = sessionCookie.split("=")[1]!;
      await AgentSession.update({ expiresAt: new Date(Date.now() - 1_000) }, { where: { tokenHash: hashSessionToken(token) } });
      assert.equal((await protectedGet("/auth/me")).statusCode, 401);
      sessionCookie = cookieFrom(await login());
      assert.equal((await app.inject({ method: "POST", url: "/auth/logout", headers: { origin, cookie: sessionCookie } })).statusCode, 204);
      assert.equal((await protectedGet("/auth/me")).statusCode, 401);
    });
  } finally {
    try {
      await app.close();
    } finally {
      try {
        if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.close();
        if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
      }
    }
  }
});
