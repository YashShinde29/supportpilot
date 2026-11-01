import { randomUUID } from "node:crypto";
import { Op } from "sequelize";
import { Draft, Message } from "../db/models.js";
import { DraftProviderError, validateDraft, type DraftProvider } from "./provider.js";

export const GENERATION_LEASE_MS = 60_000;

export async function generateDraft(messageId: string, provider: DraftProvider, retryFailed = false) {
  const token = randomUUID();
  const eligible = [
    { status: "pending", generationToken: { [Op.is]: null } },
    { status: "pending", generationStartedAt: { [Op.lt]: new Date(Date.now() - GENERATION_LEASE_MS) } },
    ...(retryFailed ? [{ status: "failed" }] : []),
  ];
  // Claim in one UPDATE. Do not hold a database transaction or connection while
  // waiting for Gemini. Only the holder of this token may store its result.
  const [claimed] = await Draft.update({
    status: "pending", text: null, errorCode: null,
    generationToken: token, generationStartedAt: new Date(),
  }, { where: { messageId, [Op.or]: eligible } });
  if (!claimed) return { outcome: "skipped" as const };

  let text: string;
  try {
    const message = await Message.findByPk(messageId);
    if (!message || message.sender !== "customer") throw new DraftProviderError("INVALID_RESPONSE");
    const preceding = await Message.findAll({
      where: { conversationId: message.conversationId, createdAt: { [Op.lt]: message.createdAt } },
      order: [["createdAt", "DESC"], ["id", "DESC"]], limit: 8,
    });
    text = validateDraft(await provider({
      message: message.text,
      history: preceding.reverse().map((m) => ({ sender: m.sender, text: m.text.slice(0, 2_000) })),
    }));
  } catch (error) {
    const errorCode = error instanceof DraftProviderError ? error.code : "PROVIDER_UNAVAILABLE";
    const [updated] = await Draft.update({
      status: "failed", text: null, errorCode, generationToken: null, generationStartedAt: null,
    }, { where: { messageId, status: "pending", generationToken: token } });
    return updated ? { outcome: "failed" as const, errorCode } : { outcome: "skipped" as const };
  }

  const [updated] = await Draft.update({
    status: "ready", text, errorCode: null, generationToken: null, generationStartedAt: null,
  }, { where: { messageId, status: "pending", generationToken: token } });
  return { outcome: updated ? "ready" as const : "skipped" as const };
}
