import { buildApp } from "./build-app.js";

const app = buildApp();
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

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
} catch (error) {
  const failure = error instanceof Error ? error as NodeJS.ErrnoException : undefined;
  app.log.error({ errorType: failure?.name ?? "UnknownError", errorCode: failure?.code, syscall: failure?.syscall },
    "API startup failed; check configuration, port availability, and database access");
  await app.close();
  process.exitCode = 1;
}
