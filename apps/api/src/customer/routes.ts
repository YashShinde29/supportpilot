import type { FastifyInstance } from "fastify";
import type { Sequelize } from "sequelize";
import type { DraftProvider } from "../ai/provider.js";
import { Customer, Conversation, Message } from "../db/models.js";
import { messageView } from "../agent/serializers.js";
import { receiveMessage } from "../messages/receive.js";
import { ApiError } from "../errors.js";

// These fictional identities are intentionally public for the assessment demo.
const customers = [
  { id: "demo_aisha", name: "Aisha", phone: "+919800001001" },
  { id: "demo_rohan", name: "Rohan", phone: "+919800001002" },
  { id: "demo_meera", name: "Meera", phone: "+919800001003" },
];
const ids = customers.map((customer) => customer.id);
type Submission = { customerId: string; clientMessageId: string; timestamp: string; text: string };

export async function customerRoutes(app: FastifyInstance, options: { db: Sequelize; provider: DraftProvider; webOrigin: string }) {
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (request.method === "POST" && request.headers.origin !== options.webOrigin) {
      throw new ApiError(403, "INVALID_ORIGIN", "Request origin is not allowed.");
    }
  });
  app.get("/customer/customers", async () => ({ customers }));
  app.get<{ Params: { id: string }; Querystring: { offset?: string } }>("/customer/conversations/:id", {
    schema: {
      params: { type: "object", required: ["id"], properties: { id: { type: "string", enum: ids } } },
      querystring: { type: "object", additionalProperties: false, properties: { offset: { type: "string", pattern: "^[0-9]{1,7}$" } } },
    },
  }, async (request) => {
    const customer = await Customer.findOne({ where: { externalId: request.params.id } });
    const conversation = customer && await Conversation.findOne({ where: { customerId: customer.id } });
    if (!conversation) return { messages: [], total: 0 };
    const { rows, count } = await Message.findAndCountAll({ where: { conversationId: conversation.id },
      limit: 100, offset: Number(request.query.offset ?? 0), order: [["createdAt", "DESC"], ["id", "DESC"]] });
    // Explicit public projection: never load or serialize drafts.
    return { messages: rows.reverse().map(messageView), total: count };
  });
  app.post<{ Body: Submission }>("/customer/messages", {
    bodyLimit: 64 * 1024,
    schema: { body: { type: "object", additionalProperties: false,
      required: ["customerId", "clientMessageId", "timestamp", "text"], properties: {
        customerId: { type: "string", enum: ids }, clientMessageId: { type: "string", format: "uuid" },
        timestamp: { type: "string", format: "date-time" },
        text: { type: "string", minLength: 1, maxLength: 10000, allOf: [{ pattern: "\\S" }, { pattern: "^[^\\u0000]*$" }] },
      } } },
  }, async (request, reply) => {
    const body = request.body;
    const result = await receiveMessage(options.db, {
      event_id: `demo_evt_${body.clientMessageId}`, type: "message.received", brand_id: "verdant-co", timestamp: body.timestamp,
      customer: customers.find((customer) => customer.id === body.customerId)!,
      message: { id: `demo_msg_${body.clientMessageId}`, type: "text", text: body.text },
    }, options.provider);
    return reply.code(result.message.status === "accepted" ? 201 : 200).send(result.message);
  });
}
