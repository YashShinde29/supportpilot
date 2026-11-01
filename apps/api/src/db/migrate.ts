import { DatabaseConfigError, readDatabaseConfig } from "./config.js";
import { createDatabaseConnection } from "./connection.js";
import { createMigrator } from "./migrator.js";

async function main() {
  const action = process.argv[2];
  if (action !== "up" && action !== "status") {
    throw new DatabaseConfigError("Use db:migrate or db:status from the project root.");
  }
  const db = createDatabaseConnection(readDatabaseConfig());
  try {
    await db.authenticate();
    const migrator = createMigrator(db);
    if (action === "up") {
      const applied = await migrator.up();
      console.log(applied.length ? `Applied: ${applied.map((m) => m.name).join(", ")}` : "No pending migrations.");
    } else {
      for (const migration of await migrator.executed()) console.log(`Applied: ${migration.name}`);
      const pending = await migrator.pending();
      for (const migration of pending) console.log(`Pending: ${migration.name}`);
      if (!pending.length) console.log("No pending migrations.");
    }
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  // Migration errors can embed SQL and connection details; do not dump objects.
  console.error(error instanceof DatabaseConfigError ? error.message :
    "Migration operation failed. Check the database connection, table ownership, and migration definitions.");
  process.exitCode = 1;
});
