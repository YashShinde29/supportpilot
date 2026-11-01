import Fastify from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildApp } from "./build-app.js";

// Vercel detects the framework from a direct import in the server entrypoint.
const app = buildApp({}, Fastify);
const port = Number(process.env.PORT ?? 3001);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

async function shutdown() {
  try {
    await app.close();
  } catch (error) {
    app.log.error({ errorType: error instanceof Error ? error.name : "UnknownError" }, "API shutdown failed");
    process.exitCode = 1;
  }
}

// Vercel imports this function without opening a port. Fastify readiness (including
// database authentication) is awaited per invocation and runs only once.
export default async function handler(request: IncomingMessage, response: ServerResponse) {
  try {
    await app.ready();
    app.server.emit("request", request, response);
  } catch (error) {
    const failure = error instanceof Error ? error as NodeJS.ErrnoException : undefined;
    app.log.error({ errorType: failure?.name ?? "UnknownError", errorCode: failure?.code }, "API readiness failed");
    if (!response.headersSent) {
      response.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "The API could not initialize. Please retry." } }));
    }
  }
}

async function startLocalServer() {
  try {
    await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
  } catch (error) {
    const failure = error instanceof Error ? error as NodeJS.ErrnoException : undefined;
    app.log.error({ errorType: failure?.name ?? "UnknownError", errorCode: failure?.code, syscall: failure?.syscall },
      "API startup failed; check configuration, port availability, and database access");
    await app.close();
    process.exitCode = 1;
  }
}

if (!process.env.VERCEL) {
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  void startLocalServer();
}
