import assert from "node:assert/strict";
import http from "node:http";

// Exercise the compiled entrypoint using Vercel's import-time listen interception.
// Requires normal API environment variables. Only performs read-only HTTP calls.
process.env.VERCEL = "1";
const originalListen = http.Server.prototype.listen;
let intercepted = false;
http.Server.prototype.listen = function () {
  intercepted = true;
  return this;
};
let server;
let timeout;
try {
  const module = await Promise.race([
    import("../apps/api/dist/server.js"),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Entry import timed out")), 5000); }),
  ]);
  clearTimeout(timeout);
  assert.equal(intercepted, false);
  assert.equal(typeof module.default, "function");
  http.Server.prototype.listen = originalListen;
  console.log("PASS: Vercel entrypoint imports without calling or waiting on listen()");
  server = http.createServer(module.default);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  console.log("PASS: exported handler serves GET /health with 200 after Neon authentication");
  const privateRoute = await fetch(`${base}/agent/conversations`);
  assert.equal(privateRoute.status, 401);
  console.log("PASS: exported handler preserves agent authentication (401 without session)");
  const publicRoute = await fetch(`${base}/customer/conversations/demo_meera`);
  assert.equal(publicRoute.status, 200);
  const data = await publicRoute.json();
  assert.ok(Array.isArray(data.messages));
  assert.ok(data.messages.every((message) => !("draft" in message)));
  console.log("PASS: public conversation route reads Neon and excludes drafts");
} catch (error) {
  console.error(`FAIL: Vercel startup check (${error instanceof Error ? error.name : "unknown"})`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  http.Server.prototype.listen = originalListen;
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  // Close the test process's remaining Sequelize pool without exposing app internals.
  process.exit(process.exitCode ?? 0);
}
