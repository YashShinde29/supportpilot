import { UniqueConstraintError, type Sequelize } from "sequelize";
import { Conversation, Draft, Message } from "../db/models.js";
import { ApiError } from "../errors.js";
import { messageView, draftView } from "./serializers.js";

export async function approveDraft(db: Sequelize, draftId: string, agentId: string, editedText: string) {
  const text = editedText.trim();
  try {
    return await db.transaction(async (transaction) => {
      const draft = await Draft.findByPk(draftId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!draft) throw new ApiError(404, "DRAFT_NOT_FOUND", "Draft not found.");
      const source = await Message.findByPk(draft.messageId, { transaction });
      if (!source || source.sender !== "customer") throw new ApiError(409, "INVALID_DRAFT", "The draft is not linked to a customer message.");

      if (draft.status === "used") {
        const existing = await Message.findOne({ where: { replyToMessageId: source.id }, transaction });
        if (existing?.text === text) {
          return { status: "already_approved" as const, reply: messageView(existing), draft: draftView(draft) };
        }
        throw new ApiError(409, "ALREADY_APPROVED", "This draft has already been approved.");
      }
      if (draft.status !== "ready") throw new ApiError(409, "DRAFT_NOT_READY", "Only a ready draft can be approved.");
      const conversation = await Conversation.findByPk(source.conversationId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!conversation) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
      const reply = await Message.create({
        conversationId: conversation.id, sender: "agent", agentId, text,
        sentAt: new Date(), replyToMessageId: source.id,
      }, { transaction });
      await draft.update({ status: "used", usedAt: new Date() }, { transaction });
      await conversation.update({ lastActivityAt: new Date(Math.max(Date.now(), conversation.lastActivityAt.getTime())) }, { transaction });
      return { status: "approved" as const, reply: messageView(reply), draft: draftView(draft) };
    });
  } catch (error) {
    if (error instanceof UniqueConstraintError) throw new ApiError(409, "ALREADY_APPROVED", "This message already has an approved reply.");
    throw error;
  }
}
