import cookie from "@fastify/cookie";
import type { FastifyInstance } from "fastify";
import type { Sequelize } from "sequelize";
import { Agent, AgentSession } from "../db/models.js";
import type { DraftProvider } from "../ai/provider.js";
import { ApiError } from "../errors.js";
import { agentRoutes } from "../agent/routes.js";
import { verifyPassword } from "./passwords.js";
import { checkLoginLimit } from "./throttle.js";
import { cookieSettings, createSession, publicAgent, sessionGuard, SESSION_SECONDS } from "./sessions.js";

export async function agentApi(app: FastifyInstance, options: { db: Sequelize; provider: DraftProvider; webOrigin: string }) {
  await app.register(cookie);
  app.decorateRequest("agent", null);
  app.decorateRequest("sessionHash", null);
  const secure = process.env.NODE_ENV === "production";
  const cookieName = secure ? "__Host-supportpilot_session" : "supportpilot_session";
  const requireAgent = sessionGuard(cookieName);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (request.method !== "GET" && request.method !== "HEAD" && request.headers.origin !== options.webOrigin) {
      throw new ApiError(403, "INVALID_ORIGIN", "This request must come from the application.");
    }
  });

  app.post<{ Body: { email: string; password: string } }>("/auth/login", {
    bodyLimit: 4 * 1024,
    schema: { body: { type: "object", additionalProperties: false, required: ["email", "password"], properties: {
      email: { type: "string", format: "email", maxLength: 255 },
      password: { type: "string", minLength: 1, maxLength: 128 },
    } } },
  }, async (request, reply) => {
    const email = request.body.email.trim().toLowerCase();
    await checkLoginLimit(options.db, email);
    const agent = await Agent.scope("withPassword").findOne({ where: { email } });
    const valid = await verifyPassword(request.body.password, agent?.passwordHash);
    if (!agent || !valid) throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    const session = await createSession(options.db, agent.id, request.cookies[cookieName]);
    reply.setCookie(cookieName, session.token, { ...cookieSettings(secure), maxAge: SESSION_SECONDS });
    return { agent: publicAgent(agent), expiresAt: session.expiresAt.toISOString() };
  });

  app.get("/auth/me", { onRequest: requireAgent }, async (request) => ({ agent: request.agent }));
  app.post("/auth/logout", { onRequest: requireAgent }, async (request, reply) => {
    await AgentSession.destroy({ where: { tokenHash: request.sessionHash! } });
    reply.clearCookie(cookieName, cookieSettings(secure));
    return reply.code(204).send();
  });

  await app.register(async (protectedApi) => {
    protectedApi.addHook("onRequest", requireAgent);
    await protectedApi.register(agentRoutes, options);
  });
}
