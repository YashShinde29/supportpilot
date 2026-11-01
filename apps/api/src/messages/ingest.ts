import { Op, UniqueConstraintError, type Sequelize, type Transaction } from "sequelize";
import { Customer, Conversation, Message, Draft } from "../db/models.js";
import { ApiError } from "../errors.js";
import type { IncomingMessageEvent } from "../webhooks/schema.js";

export interface IngestionResult {
  status: "accepted" | "duplicate";
  messageId: string;
  conversationId: string;
}

// Webhook and Customer routes validate input before calling this shared service.
// Customer routes map public demo identities and namespace request IDs on the server.
export async function ingestMessage(db: Sequelize, event: IncomingMessageEvent): Promise<IngestionResult> {
  async function findDuplicate(transaction: Transaction): Promise<IngestionResult | null> {
    const matches = await Message.findAll({
      where: { [Op.or]: [{ eventId: event.event_id }, { externalId: event.message.id }] },
      transaction,
    });
    if (!matches.length) return null;
    const existing = matches[0]!;
    const conversation = await Conversation.findByPk(existing.conversationId, { transaction });
    const customer = conversation ? await Customer.findByPk(conversation.customerId, { transaction }) : null;
    if (matches.length !== 1 || existing.sender !== "customer" ||
        existing.eventId !== event.event_id || existing.externalId !== event.message.id ||
        customer?.externalId !== event.customer.id || existing.text !== event.message.text ||
        existing.sentAt.getTime() !== new Date(event.timestamp).getTime()) {
      throw new ApiError(409, "EVENT_CONFLICT", "An event or message ID was already used for different message details.");
    }
    // Names/phones may change on later messages. A retry must not overwrite them
    // or update conversation activity, nor recreate/reset an existing draft.
    return { status: "duplicate", messageId: existing.id, conversationId: existing.conversationId };
  }

  try {
    return await db.transaction(async (transaction) => {
      const duplicate = await findDuplicate(transaction);
      if (duplicate) return duplicate;

      const [customer] = await Customer.findOrCreate({
        where: { externalId: event.customer.id },
        defaults: { externalId: event.customer.id, name: event.customer.name.trim(), phone: event.customer.phone.trim() },
        transaction,
      });
      // Lock this customer's row to serialize simultaneous messages and their
      // conversation activity updates. Locks are released on commit/rollback.
      await customer.reload({ transaction, lock: transaction.LOCK.UPDATE });
      await customer.update({ name: event.customer.name.trim(), phone: event.customer.phone.trim() }, { transaction });

      const [conversation] = await Conversation.findOrCreate({
        where: { customerId: customer.id }, defaults: { customerId: customer.id }, transaction,
      });
      const message = await Message.create({
        conversationId: conversation.id, sender: "customer", text: event.message.text,
        sentAt: new Date(event.timestamp), externalId: event.message.id, eventId: event.event_id,
      }, { transaction });
      await Draft.create({ messageId: message.id, status: "pending" }, { transaction });
      // Activity reflects receipt time, not an untrusted/future webhook timestamp.
      await conversation.update({
        lastActivityAt: new Date(Math.max(Date.now(), conversation.lastActivityAt.getTime())),
      }, { transaction });
      return { status: "accepted", messageId: message.id, conversationId: conversation.id };
    });
  } catch (error) {
    if (error instanceof UniqueConstraintError) {
      // Another request may have committed after our initial lookup. The failed
      // transaction is rolled back before examining the winning message.
      const duplicate = await db.transaction(findDuplicate);
      if (duplicate) return duplicate;
    }
    throw error;
  }
}
