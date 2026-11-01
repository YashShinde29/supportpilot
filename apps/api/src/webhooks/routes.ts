import type { FastifyInstance } from "fastify";
import type { Sequelize } from "sequelize";
import { ApiError } from "../errors.js";
import { receiveMessage } from "../messages/receive.js";
import { incomingMessageSchema, webhookResponseSchema, type IncomingMessageEvent } from "./schema.js";
import { hasValidSignature } from "./signature.js";
import type { DraftProvider } from "../ai/provider.js";

export async function webhookRoutes(app: FastifyInstance, options: { db: Sequelize; secret: string; draftProvider: DraftProvider }) {
  // Encapsulated in this plugin: other routes keep normal JSON parsing.
  // Preserve exact bytes, including whitespace and Unicode, for the HMAC.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  app.post<{ Body: IncomingMessageEvent }>("/webhook", {
    bodyLimit: 64 * 1024,
    schema: { body: incomingMessageSchema, response: { "2xx": webhookResponseSchema } },
    preValidation: async (request) => {
      const rawBody: unknown = request.body;
      if (!Buffer.isBuffer(rawBody) || !hasValidSignature(rawBody, request.headers["x-signature"], options.secret)) {
        throw new ApiError(401, "INVALID_SIGNATURE", "A valid webhook signature is required.");
      }
      try {
        request.body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
      } catch {
        throw new ApiError(400, "INVALID_JSON", "The request body must be valid UTF-8 JSON.");
      }
      // Fastify performs schema validation after this hook and before the handler.
    },
  }, async (request, reply) => {
    const { message: result, draft } = await receiveMessage(options.db, request.body, options.draftProvider);
    request.log.info({ messageId: result.messageId, ...draft }, "Draft generation completed");
    request.log.info({ eventId: request.body.event_id, messageId: result.messageId, result: result.status }, "Webhook handled");
    return reply.code(result.status === "accepted" ? 201 : 200).send(result);
  });
}
