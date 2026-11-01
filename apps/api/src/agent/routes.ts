import type { FastifyInstance } from "fastify";
import type { Sequelize } from "sequelize";
import { Customer, Conversation, Draft, Message } from "../db/models.js";
import { ApiError } from "../errors.js";
import { generateDraft } from "../ai/generate-draft.js";
import type { DraftProvider } from "../ai/provider.js";
import { approveDraft } from "./approve.js";
import { customerView, draftView, messageView } from "./serializers.js";

const idSchema = {
  type: "object", additionalProperties: false, required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
};
const pageSchema = {
  type: "object", additionalProperties: false,
  properties: {
    limit: { type: "string", pattern: "^(?:[1-9]|[1-9][0-9]|100)$" },
    offset: { type: "string", pattern: "^[0-9]{1,7}$" },
  },
};
type Page = { limit?: string; offset?: string };

// All routes in this plugin are behind the session guard installed by agentApi.
export async function agentRoutes(app: FastifyInstance, options: { db: Sequelize; provider: DraftProvider }) {
  app.get<{ Querystring: Page }>("/agent/conversations", { schema: { querystring: pageSchema } }, async (request) => {
    const limit = Number(request.query.limit ?? 20);
    const offset = Number(request.query.offset ?? 0);
    const { count, rows } = await Conversation.findAndCountAll({
      limit, offset, distinct: true,
      order: [["lastActivityAt", "DESC"], ["id", "DESC"]],
      include: [
        { model: Customer, as: "customer", required: true },
        { model: Message, as: "messages", separate: true, limit: 1, order: [["createdAt", "DESC"], ["id", "DESC"]] },
      ],
    });
    return { total: count, limit, offset, items: rows.map((conversation) => {
      const latest = (conversation.get("messages") as Message[])[0];
      return {
        id: conversation.id,
        customer: customerView(conversation.get("customer") as Customer),
        lastActivityAt: conversation.lastActivityAt.toISOString(),
        latestMessage: latest ? { ...messageView(latest), text: latest.text.slice(0, 160) } : null,
      };
    }) };
  });

  app.get<{ Params: { id: string }; Querystring: Page }>("/agent/conversations/:id", {
    schema: { params: idSchema, querystring: pageSchema },
  }, async (request) => {
    const conversation = await Conversation.findByPk(request.params.id, { include: [{ model: Customer, as: "customer" }] });
    if (!conversation) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
    const limit = Number(request.query.limit ?? 100);
    const offset = Number(request.query.offset ?? 0);
    const { count, rows } = await Message.findAndCountAll({
      where: { conversationId: conversation.id }, limit, offset, distinct: true,
      order: [["createdAt", "DESC"], ["id", "DESC"]], include: [{ model: Draft, as: "draft" }],
    });
    return {
      conversation: { id: conversation.id, customer: customerView(conversation.get("customer") as Customer), lastActivityAt: conversation.lastActivityAt.toISOString() },
      total: count, limit, offset,
      messages: rows.reverse().map((message) => {
        const draft = message.get("draft") as Draft | null;
        return { ...messageView(message), draft: draft ? draftView(draft) : null };
      }),
    };
  });

  app.post<{ Params: { id: string }; Body: { text: string } }>("/agent/drafts/:id/approve", {
    bodyLimit: 32 * 1024,
    schema: {
      params: idSchema,
      body: { type: "object", additionalProperties: false, required: ["text"], properties: {
        text: { type: "string", minLength: 1, maxLength: 4_000, allOf: [{ pattern: "\\S" }, { pattern: "^[^\\u0000]*$" }] },
      } },
    },
  }, async (request, reply) => {
    const result = await approveDraft(options.db, request.params.id, request.agent!.id, request.body.text);
    request.log.info({ agentId: request.agent!.id, draftId: request.params.id, messageId: result.reply.id }, "Draft approved");
    return reply.code(result.status === "approved" ? 201 : 200).send(result);
  });

  app.post<{ Params: { id: string } }>("/agent/drafts/:id/retry", { schema: { params: idSchema } }, async (request, reply) => {
    const draft = await Draft.findByPk(request.params.id);
    if (!draft) throw new ApiError(404, "DRAFT_NOT_FOUND", "Draft not found.");
    if (draft.status === "ready" || draft.status === "used") throw new ApiError(409, "DRAFT_COMPLETE", "This draft does not need regeneration.");
    const result = await generateDraft(draft.messageId, options.provider, true);
    await draft.reload();
    request.log.info({ agentId: request.agent!.id, draftId: draft.id, ...result }, "Draft retry handled");
    return reply.code(draft.status === "pending" ? 202 : 200).send({ draft: draftView(draft) });
  });
}
