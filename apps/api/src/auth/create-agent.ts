import { readDatabaseConfig } from "../db/config.js";
import { createDatabaseConnection } from "../db/connection.js";
import { initializeModels } from "../db/models.js";
import { hashPassword } from "./passwords.js";

async function main() {
  const email = process.env.AGENT_EMAIL?.trim().toLowerCase();
  const name = process.env.AGENT_NAME?.trim() || "Support Agent";
  const password = process.env.AGENT_PASSWORD ?? "";
  if (!email || email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error("Set a valid AGENT_EMAIL in apps/api/.env."); process.exitCode = 1; return;
  }
  if (password.length < 12 || password.length > 128 || !password.trim()) {
    console.error("Set AGENT_PASSWORD to a password of 12–128 characters in apps/api/.env."); process.exitCode = 1; return;
  }
  const db = createDatabaseConnection(readDatabaseConfig());
  const { Agent } = initializeModels(db);
  try {
    if (await Agent.findOne({ where: { email } })) {
      console.log("An agent with this email already exists; its credentials were not changed."); return;
    }
    await Agent.create({ email, name, passwordHash: await hashPassword(password) });
    console.log("Agent account created. The database stores only a salted password hash.");
  } finally {
    await db.close();
  }
}

main().catch(() => {
  console.error("Agent creation failed. Check database connectivity, migrations, and account settings.");
  process.exitCode = 1;
});
