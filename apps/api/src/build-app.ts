import Fastify, { type FastifyError } from "fastify";
import type { Sequelize } from "sequelize";
import { readDatabaseConfig } from "./db/config.js";
import { createDatabaseConnection } from "./db/connection.js";
import { initializeModels } from "./db/models.js";
import { ApiError } from "./errors.js";
import { webhookRoutes } from "./webhooks/routes.js";
import { createGeminiProvider } from "./ai/gemini.js";
import type { DraftProvider } from "./ai/provider.js";
import { agentApi } from "./auth/routes.js";
import { customerRoutes } from "./customer/routes.js";

export function buildApp(options: { db?: Sequelize; webhookSecret?: string; logger?: boolean; draftProvider?: DraftProvider; webOrigin?: string } = {}, createFastify: typeof Fastify = Fastify) {
  const secret = options.webhookSecret ?? process.env.WEBHOOK_SECRET;
  if (!secret?.trim()) throw new Error("Set WEBHOOK_SECRET in apps/api/.env before starting the API.");
  const draftProvider = options.draftProvider ?? createGeminiProvider();
  const webOrigin = options.webOrigin ?? process.env.WEB_ORIGIN ?? "http://localhost:3000";
  const parsedOrigin = new URL(webOrigin);
  if (parsedOrigin.origin !== webOrigin || !["http:", "https:"].includes(parsedOrigin.protocol) ||
      (process.env.NODE_ENV === "production" && parsedOrigin.protocol !== "https:")) {
    throw new Error("WEB_ORIGIN must be an exact HTTP(S) origin, using HTTPS in production.");
  }
  const db = options.db ?? createDatabaseConnection(readDatabaseConfig());
  initializeModels(db);
  const app = createFastify({
    logger: options.logger ?? true,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } },
  });

  app.addHook("onReady", async () => { await db.authenticate(); });
  app.addHook("onClose", async () => { await db.close(); });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message }, requestId: request.id });
    }
    const failure = error instanceof Error ? error as FastifyError : undefined;
    if (failure?.validation) {
      return reply.code(400).send({
        error: { code: "INVALID_PAYLOAD", message: "The request does not match the expected format.",
          details: failure.validation.map(({ instancePath, message }) => ({ path: instancePath, message })) },
        requestId: request.id,
      });
    }
    if (failure?.statusCode === 413 || failure?.statusCode === 415) {
      return reply.code(failure.statusCode).send({ error: {
        code: failure.statusCode === 413 ? "PAYLOAD_TOO_LARGE" : "UNSUPPORTED_MEDIA_TYPE",
        message: failure.statusCode === 413 ? "The request body exceeds the allowed size." : "Use Content-Type: application/json.",
      }, requestId: request.id });
    }
    // Never log SQL, request bodies, signatures, or connection objects.
    request.log.error({ errorType: failure?.name ?? "UnknownError", errorCode: failure?.code }, "Request failed");
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "The request could not be processed. Please retry." }, requestId: request.id });
  });

  // Liveness only. Database authentication also runs once during startup.
  app.get("/health", async () => ({ status: "ok" }));
  app.register(webhookRoutes, { db, secret, draftProvider });
  app.register(agentApi, { db, provider: draftProvider, webOrigin });
  app.register(customerRoutes, { db, provider: draftProvider, webOrigin });

  return app;
}
