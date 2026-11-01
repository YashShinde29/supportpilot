import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { buildApp } from "../src/build-app.js";
import { readDatabaseConfig } from "../src/db/config.js";
import { createDatabaseConnection } from "../src/db/connection.js";
import { createMigrator } from "../src/db/migrator.js";
import { Customer, Conversation, Message, Draft } from "../src/db/models.js";
import type { IncomingMessageEvent } from "../src/webhooks/schema.js";
import { generateDraft, GENERATION_LEASE_MS } from "../src/ai/generate-draft.js";
import { DraftProviderError, type DraftProvider, type DraftInput } from "../src/ai/provider.js";
import { ingestMessage } from "../src/messages/ingest.js";

test("signed webhook with real PostgreSQL", { timeout: 60_000 }, async (t) => {
  const config = readDatabaseConfig(process.env, true);
  const admin = createDatabaseConnection(config);
  // The schema name is generated here, never accepted from an environment variable.
  const schema = `webhook_test_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^webhook_test_[a-f0-9]{32}$/);
  // Model metadata queries also need the schema (search_path alone is not enough).
  const db = createDatabaseConnection(config, schema);
  db.addHook("afterConnect", async (connection) => {
    await (connection as { query: (sql: string) => Promise<unknown> })
      .query(`SET search_path TO "${schema}"`);
  });
  const secret = randomUUID();
  const providerInputs: DraftInput[] = [];
  let provider: DraftProvider = async () => "Test draft for human review.";
  const app = buildApp({ db, webhookSecret: secret, logger: false, draftProvider: async (input) => {
    providerInputs.push(input);
    return provider(input);
  } });
  let schemaCreated = false;
  function event(): IncomingMessageEvent {
    return {
      event_id: `evt_${randomUUID()}`, type: "message.received", brand_id: "verdant-co",
      timestamp: "2026-11-03T10:15:22Z",
      customer: { id: `cust_${randomUUID()}`, name: "Aisha Khan", phone: "+919800000001" },
      message: { id: `msg_${randomUUID()}`, type: "text", text: "Is cash on delivery available for a ₹3,500 order?" },
    };
  }
  const sign = (body: string | Buffer) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const send = (body: string | Buffer, signature = sign(body), contentType = "application/json") => app.inject({
    method: "POST", url: "/webhook", payload: body,
    headers: { "content-type": contentType, "x-signature": signature },
  });

  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await createMigrator(db, schema).up();
    await app.ready();

    await t.test("rejects missing, malformed, and wrong signatures without saving anything", async () => {
      const body = JSON.stringify(event());
      const missing = await app.inject({ method: "POST", url: "/webhook", payload: body, headers: { "content-type": "application/json" } });
      assert.equal(missing.statusCode, 401);
      for (const signature of ["sha256=abc", "sha256=" + "z".repeat(64), "sha256=" + "0".repeat(64)]) {
        const response = await send(body, signature);
        assert.equal(response.statusCode, 401);
        assert.equal(response.json().error.code, "INVALID_SIGNATURE");
      }
      assert.equal(await Customer.count(), 0);
      assert.equal(await Message.count(), 0);
    });

    const first = event();
    const raw = JSON.stringify(first, null, 2) + "\n";
    let messageId: string;
    let conversationId: string;
    await t.test("validates raw bytes, stores Unicode text, and generates a draft without sending a reply", async () => {
      assert.equal((await send(raw, sign(JSON.stringify(first)))).statusCode, 401);
      const response = await send(raw);
      assert.equal(response.statusCode, 201, response.body);
      const result = response.json();
      assert.equal(result.status, "accepted");
      messageId = result.messageId;
      conversationId = result.conversationId;
      const stored = await Message.findByPk(messageId);
      assert.equal(stored?.text, first.message.text);
      assert.equal(stored?.sentAt.toISOString(), new Date(first.timestamp).toISOString());
      const draft = await Draft.findOne({ where: { messageId } });
      assert.equal(draft?.status, "ready");
      assert.equal(draft?.text, "Test draft for human review.");
      assert.equal(draft?.generationToken, null);
      assert.equal(await Message.count({ where: { sender: "agent" } }), 0);
      assert.ok(!("draft" in result));
    });

    await t.test("retries preserve activity and do not reset an existing draft", async () => {
      const callsBefore = providerInputs.length;
      const before = await Conversation.findByPk(conversationId);
      await Draft.update({ status: "ready", text: "Existing draft" }, { where: { messageId } });
      const response = await send(JSON.stringify(first));
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().status, "duplicate");
      assert.equal(response.json().messageId, messageId);
      assert.equal(await Message.count(), 1);
      assert.equal(await Draft.count(), 1);
      assert.equal((await Draft.findOne({ where: { messageId } }))?.status, "ready");
      assert.equal((await Conversation.findByPk(conversationId))?.lastActivityAt.getTime(), before?.lastActivityAt.getTime());
      assert.equal(providerInputs.length, callsBefore);
    });

    await t.test("rejects conflicting IDs, message content, and customer identity", async () => {
      for (const altered of [
        { ...first, message: { ...first.message, text: "Changed text" } },
        { ...first, customer: { ...first.customer, id: "different-customer" } },
        { ...first, timestamp: "2026-11-04T10:15:22Z" },
        { ...first, event_id: `evt_${randomUUID()}` },
        { ...first, message: { ...first.message, id: `msg_${randomUUID()}` } },
      ]) {
        const response = await send(JSON.stringify(altered));
        assert.equal(response.statusCode, 409, response.body);
        assert.equal(response.json().error.code, "EVENT_CONFLICT");
      }
      assert.equal(await Customer.count(), 1);
      assert.equal(await Message.count(), 1);
    });

    await t.test("validates JSON, field types, supported events, and text before any writes", async () => {
      assert.equal((await send("{broken json")).statusCode, 400);
      assert.equal((await send(Buffer.from([0xff]))).statusCode, 400);
      for (const invalid of [
        null, [], {}, { ...event(), brand_id: "other-brand" },
        { ...event(), type: "message.deleted" }, { ...event(), timestamp: "yesterday" },
        { ...event(), unexpected: true }, { ...event(), customer: { ...first.customer, id: 123 } },
        { ...event(), message: { ...first.message, text: " \n\t" } },
        { ...event(), message: { ...first.message, text: "bad\u0000text" } },
        { ...event(), message: { ...first.message, type: "image" } },
      ]) {
        const response = await send(JSON.stringify(invalid));
        assert.equal(response.statusCode, 400, response.body);
        assert.equal(response.json().error.code, "INVALID_PAYLOAD");
      }
      const oversized = JSON.stringify({ ...event(), padding: "x".repeat(70_000) });
      assert.equal((await send(oversized)).statusCode, 413);
      assert.equal((await send("text", sign("text"), "text/plain")).statusCode, 415);
      assert.equal(await Customer.count(), 1);
      assert.equal(await Message.count(), 1);
    });

    await t.test("a second message uses the same customer and conversation", async () => {
      const next = { ...event(), customer: { ...first.customer, name: "Aisha Updated" } };
      const response = await send(JSON.stringify(next));
      assert.equal(response.statusCode, 201);
      assert.equal(response.json().conversationId, conversationId);
      assert.equal(await Customer.count(), 1);
      assert.equal(await Conversation.count(), 1);
      assert.equal(await Message.count(), 2);
      assert.equal((await Customer.findOne({ where: { externalId: first.customer.id } }))?.name, "Aisha Updated");
      const context = providerInputs.at(-1)!;
      assert.ok(context.history.some((m) => m.text === first.message.text));
      assert.deepEqual(Object.keys(context).sort(), ["history", "message"]);
      await send(JSON.stringify(first));
      assert.equal((await Customer.findOne({ where: { externalId: first.customer.id } }))?.name, "Aisha Updated");
    });

    await t.test("simultaneous exact retries save one message and draft", async () => {
      const callsBefore = providerInputs.length;
      const concurrent = event();
      const responses = await Promise.all(Array.from({ length: 5 }, () => send(JSON.stringify(concurrent))));
      assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 200, 200, 200, 201]);
      assert.equal(new Set(responses.map((r) => r.json().messageId)).size, 1);
      assert.equal(await Message.count({ where: { externalId: concurrent.message.id } }), 1);
      assert.equal(await Draft.count({ where: { messageId: responses[0]!.json().messageId } }), 1);
      assert.equal(providerInputs.length, callsBefore + 1);
    });

    await t.test("simultaneous different messages create one conversation for a new customer", async () => {
      const customer = event().customer;
      const inputs = Array.from({ length: 4 }, () => ({ ...event(), customer }));
      const responses = await Promise.all(inputs.map((e) => send(JSON.stringify(e))));
      for (const response of responses) assert.equal(response.statusCode, 201, response.body);
      assert.equal(new Set(responses.map((r) => r.json().conversationId)).size, 1);
      assert.equal(await Customer.count({ where: { externalId: customer.id } }), 1);
      assert.equal(await Message.count({ where: { conversationId: responses[0]!.json().conversationId } }), 4);
    });

    await t.test("a draft storage failure rolls back customer, conversation, and message", async () => {
      const input = event();
      const countsBefore = [await Customer.count(), await Conversation.count(), await Message.count(), await Draft.count()];
      Draft.addHook("beforeCreate", "simulate-write-failure", () => { throw new Error("private database error detail"); });
      try {
        const response = await send(JSON.stringify(input));
        assert.equal(response.statusCode, 500);
        assert.equal(response.json().error.code, "INTERNAL_ERROR");
        assert.ok(!response.body.includes("private database error detail"));
        assert.ok(response.json().requestId);
      } finally {
        Draft.removeHook("beforeCreate", "simulate-write-failure");
      }
      assert.deepEqual([await Customer.count(), await Conversation.count(), await Message.count(), await Draft.count()], countsBefore);
      assert.equal((await send(JSON.stringify(input))).statusCode, 201);
    });

    await t.test("provider errors keep messages saved, record safe codes, and allow explicit retry", async () => {
      for (const code of ["RATE_LIMITED", "TIMEOUT", "AUTH_ERROR", "BLOCKED"] as const) {
        const input = event();
        provider = async () => { throw new DraftProviderError(code); };
        try {
          const response = await send(JSON.stringify(input));
          assert.equal(response.statusCode, 201);
          const id = response.json().messageId as string;
          assert.ok(await Message.findByPk(id));
          const failed = await Draft.findOne({ where: { messageId: id } });
          assert.equal(failed?.status, "failed");
          assert.equal(failed?.errorCode, code);
          assert.equal(failed?.generationToken, null);
          const callsBefore = providerInputs.length;
          assert.equal((await send(JSON.stringify(input))).statusCode, 200);
          assert.equal(providerInputs.length, callsBefore, "Failed duplicates must not repeatedly consume quota.");
          assert.equal((await generateDraft(id, async () => "Recovered draft", true)).outcome, "ready");
          assert.equal((await Draft.findOne({ where: { messageId: id } }))?.errorCode, null);
        } finally {
          provider = async () => "Test draft for human review.";
        }
      }
    });

    await t.test("invalid provider output becomes a failed draft and never an agent message", async () => {
      for (const output of [" ", "x".repeat(4_001), "bad\u0000text"]) {
        provider = async () => output;
        try {
          const response = await send(JSON.stringify(event()));
          assert.equal(response.statusCode, 201);
          const draft = await Draft.findOne({ where: { messageId: response.json().messageId } });
          assert.equal(draft?.status, "failed");
          assert.equal(draft?.errorCode, "INVALID_RESPONSE");
        } finally {
          provider = async () => "Test draft for human review.";
        }
      }
      assert.equal(await Message.count({ where: { sender: "agent" } }), 0);
    });

    await t.test("a lease prevents duplicate generation and stale attempts cannot overwrite recovery", async () => {
      const stored = await ingestMessage(db, event());
      let release!: (text: string) => void;
      let started!: () => void;
      const response = new Promise<string>((resolve) => { release = resolve; });
      const begun = new Promise<void>((resolve) => { started = resolve; });
      const slowAttempt = generateDraft(stored.messageId, async () => { started(); return response; });
      try {
        await begun;
        let duplicateCalls = 0;
        const duplicate = await generateDraft(stored.messageId, async () => { duplicateCalls++; return "Wrong"; });
        assert.equal(duplicate.outcome, "skipped");
        assert.equal(duplicateCalls, 0);
        // Simulate a process stalled past the lease, without waiting a minute.
        await Draft.update({ generationStartedAt: new Date(Date.now() - GENERATION_LEASE_MS - 1_000) },
          { where: { messageId: stored.messageId } });
        const recovered = await generateDraft(stored.messageId, async () => "Recovered answer");
        assert.equal(recovered.outcome, "ready");
        release("Stale answer");
        assert.equal((await slowAttempt).outcome, "skipped");
        const draft = await Draft.findOne({ where: { messageId: stored.messageId } });
        assert.equal(draft?.text, "Recovered answer");
        assert.equal(draft?.generationToken, null);
        await draft!.update({ status: "used", usedAt: new Date() });
        assert.equal((await generateDraft(stored.messageId, async () => "Must not replace", true)).outcome, "skipped");
        assert.equal((await draft!.reload()).text, "Recovered answer");
      } finally {
        release("Cleanup");
        await slowAttempt;
      }
    });
  } finally {
    try {
      await app.close();
    } finally {
      try {
        if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.close();
      }
    }
  }
});
