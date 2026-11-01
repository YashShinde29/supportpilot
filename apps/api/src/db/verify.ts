import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Transaction } from "sequelize";
import { readDatabaseConfig } from "./config.js";
import { createDatabaseConnection } from "./connection.js";
import { createMigrator } from "./migrator.js";
import { initializeModels } from "./models.js";

// Integration checks against real PostgreSQL. All sample rows are rolled back,
// including when an assertion fails. Never use sync(), truncate(), or reset here.
async function verify() {
  const db = createDatabaseConnection(readDatabaseConfig(process.env, true));
  const { Customer, Agent, Conversation, Message, Draft } = initializeModels(db);
  const token = randomUUID();
  let check = "migration status";

  try {
    await db.authenticate();
    const migrator = createMigrator(db);
    assert.equal((await migrator.pending()).length, 0, "Run db:migrate before db:verify.");
    assert.ok((await migrator.executed()).some((m) => m.name === "001-initial-schema"));

    const transaction = await db.transaction();
    let customerId: string | undefined;
    let agentId: string | undefined;
    try {
      const options = { transaction };
      const customerInput = { externalId: `verify-${token}`, name: "Verification Customer", phone: "+919800000001" };
      check = "model creation and relationships";
      const customer = await Customer.create(customerInput, options);
      customerId = customer.id;
      const conversation = await Conversation.create({ customerId: customer.id }, options);
      const agent = await Agent.create({
        email: `verify-${token}@example.invalid`, name: "Verification Agent",
        // Fixture only: not a usable authentication hash; it is rolled back.
        passwordHash: "verification-fixture-not-a-login",
      }, options);
      agentId = agent.id;
      const messageInput = {
        conversationId: conversation.id, sender: "customer" as const,
        text: "What is your return policy?", sentAt: new Date(),
        externalId: `msg-${token}`, eventId: `evt-${token}`,
      };
      const incoming = await Message.create(messageInput, options);
      const draft = await Draft.create({ messageId: incoming.id }, options);
      assert.equal(draft.status, "pending");
      const loaded = await Conversation.findByPk(conversation.id, {
        ...options,
        include: [
          { model: Customer, as: "customer" },
          { model: Message, as: "messages", include: [{ model: Draft, as: "draft" }] },
        ],
      });
      assert.ok(loaded);
      assert.equal((loaded.get("customer") as InstanceType<typeof Customer>).id, customer.id);
      const loadedMessages = loaded.get("messages") as InstanceType<typeof Message>[];
      assert.equal(loadedMessages.length, 1);
      assert.equal((loadedMessages[0]!.get("draft") as InstanceType<typeof Draft>).id, draft.id);
      const publicAgent = await Agent.findByPk(agent.id, options);
      assert.ok(publicAgent);
      assert.equal(publicAgent.get("passwordHash"), undefined);
      const loginAgent = await Agent.scope("withPassword").findByPk(agent.id, options);
      assert.equal(loginAgent?.passwordHash, "verification-fixture-not-a-login");

      async function rejectsConstraint(label: string, code: string, action: (savepoint: Transaction) => Promise<unknown>) {
        check = label;
        // A rejected SQL statement aborts its transaction. Isolate each expected
        // rejection in a savepoint so the outer verification can continue.
        await assert.rejects(
          () => db.transaction({ transaction }, action),
          (error: unknown) => error instanceof Error && "parent" in error &&
            (error.parent as { code?: string }).code === code,
        );
      }

      await rejectsConstraint("unique external customer ID", "23505", (t) => Customer.create(customerInput, { transaction: t }));
      await rejectsConstraint("one conversation per customer", "23505", (t) =>
        Conversation.create({ customerId: customer.id }, { transaction: t }));
      await rejectsConstraint("unique webhook event ID", "23505", (t) =>
        Message.create({ ...messageInput, externalId: `other-msg-${token}` }, { transaction: t }));
      await rejectsConstraint("unique external message ID", "23505", (t) =>
        Message.create({ ...messageInput, eventId: `other-evt-${token}` }, { transaction: t }));
      await rejectsConstraint("foreign key integrity", "23503", (t) =>
        Conversation.create({ customerId: randomUUID() }, { transaction: t }));
      await rejectsConstraint("one draft per message", "23505", (t) =>
        Draft.create({ messageId: incoming.id }, { transaction: t }));
      await rejectsConstraint("ready draft requires text", "23514", (t) =>
        Draft.update({ status: "ready" }, { where: { id: draft.id }, transaction: t }));
      await rejectsConstraint("message cannot be blank", "23514", (t) =>
        Message.create({ ...messageInput, text: " ", externalId: `blank-msg-${token}`, eventId: `blank-evt-${token}` }, { transaction: t }));
      await rejectsConstraint("agent message requires agent and reply target", "23514", (t) =>
        Message.create({ conversationId: conversation.id, sender: "agent", text: "Reply", sentAt: new Date() }, { transaction: t }));

      check = "failed draft can be retried";
      await draft.update({ status: "failed", errorCode: "PROVIDER_UNAVAILABLE" }, options);
      await draft.update({ status: "pending", errorCode: null }, options);
      await draft.update({ status: "ready", text: "Returns are accepted within 7 days for unopened, unused products." }, options);
      await rejectsConstraint("used draft requires usage timestamp", "23514", (t) =>
        Draft.update({ status: "used" }, { where: { id: draft.id }, transaction: t }));

      const otherCustomer = await Customer.create({ ...customerInput, externalId: `other-${token}` }, options);
      const otherConversation = await Conversation.create({ customerId: otherCustomer.id }, options);
      const replyInput = {
        conversationId: conversation.id, sender: "agent" as const, text: "Agent-edited reply",
        sentAt: new Date(), agentId: agent.id, replyToMessageId: incoming.id,
      };
      await rejectsConstraint("reply must stay in its source conversation", "23503", (t) =>
        Message.create({ ...replyInput, conversationId: otherConversation.id }, { transaction: t }));
      check = "approval storage";
      const reply = await Message.create(replyInput, options);
      await draft.update({ status: "used", usedAt: new Date() }, options);
      const linked = await Message.findByPk(incoming.id, { ...options, include: [{ model: Message, as: "reply" }] });
      assert.equal((linked?.get("reply") as InstanceType<typeof Message>).id, reply.id);
      await rejectsConstraint("one approved reply per incoming message", "23505", (t) =>
        Message.create(replyInput, { transaction: t }));
    } finally {
      await transaction.rollback();
    }

    check = "verification rows rolled back";
    assert.equal(await Customer.findByPk(customerId), null);
    assert.equal(await Agent.findByPk(agentId), null);
    console.log("Database verification passed: models, associations, uniqueness, foreign keys, draft states, and reply constraints. Temporary rows rolled back.");
  } catch {
    // Do not dump SQL values or connection objects on failure.
    console.error(`Database verification failed at: ${check}.`);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

verify().catch(() => {
  console.error("Database verification could not start. Check local database configuration.");
  process.exitCode = 1;
});
