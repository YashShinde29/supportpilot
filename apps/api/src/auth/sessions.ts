import { createHash, randomBytes } from "node:crypto";
import { Op, type Sequelize } from "sequelize";
import type { FastifyRequest } from "fastify";
import { Agent, AgentSession } from "../db/models.js";
import { ApiError } from "../errors.js";

export interface SignedInAgent { id: string; name: string; email: string }
declare module "fastify" {
  interface FastifyRequest {
    agent: SignedInAgent | null;
    sessionHash: string | null;
  }
}

export const SESSION_SECONDS = 12 * 60 * 60;
export const hashSessionToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const publicAgent = (agent: Agent): SignedInAgent => ({ id: agent.id, name: agent.name, email: agent.email });

export function cookieSettings(secure: boolean) {
  return { path: "/", httpOnly: true, sameSite: "lax" as const, secure };
}

export async function createSession(db: Sequelize, agentId: string, previous?: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1_000);
  await db.transaction(async (transaction) => {
    await AgentSession.destroy({ where: { expiresAt: { [Op.lte]: new Date() } }, transaction });
    if (previous && /^[A-Za-z0-9_-]{43}$/.test(previous)) {
      await AgentSession.destroy({ where: { tokenHash: hashSessionToken(previous) }, transaction });
    }
    await AgentSession.create({ agentId, tokenHash: hashSessionToken(token), expiresAt }, { transaction });
  });
  return { token, expiresAt };
}

export function sessionGuard(cookieName: string) {
  return async (request: FastifyRequest) => {
    const token = request.cookies[cookieName];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in.");
    const tokenHash = hashSessionToken(token);
    const session = await AgentSession.findOne({
      where: { tokenHash, expiresAt: { [Op.gt]: new Date() } },
      include: [{ model: Agent, as: "agent", attributes: ["id", "name", "email"] }],
    });
    const agent = session?.get("agent") as Agent | undefined;
    if (!agent) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in.");
    request.agent = publicAgent(agent);
    request.sessionHash = tokenHash;
  };
}
