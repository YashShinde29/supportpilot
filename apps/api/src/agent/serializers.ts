import type { Customer, Draft, Message } from "../db/models.js";

export const customerView = (customer: Customer) => ({ id: customer.id, name: customer.name, phone: customer.phone });
export const draftView = (draft: Draft) => ({
  id: draft.id, status: draft.status, text: draft.text,
  errorCode: draft.errorCode, usedAt: draft.usedAt?.toISOString() ?? null,
});
export const messageView = (message: Message) => ({
  id: message.id, sender: message.sender, text: message.text,
  sentAt: message.sentAt.toISOString(), createdAt: message.createdAt.toISOString(),
  replyToMessageId: message.replyToMessageId,
});
