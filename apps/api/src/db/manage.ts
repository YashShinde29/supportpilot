import { QueryTypes } from "sequelize";
import { DatabaseConfigError, readDatabaseConfig } from "./config.js";
import { createDatabaseConnection } from "./connection.js";

async function main() {
  const command = process.argv[2];
  if (command !== "check" && command !== "create") {
    throw new DatabaseConfigError("Use db:check or db:create from the project root.");
  }

  const config = readDatabaseConfig();
  // CREATE DATABASE must run against an existing maintenance database.
  const connection = createDatabaseConnection({
    ...config,
    database: command === "create" ? "postgres" : config.database,
  });

  try {
    await connection.authenticate();

    if (command === "create") {
      const existing = await connection.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE datname = $1",
        { bind: [config.database], type: QueryTypes.SELECT },
      );

      if (existing.length > 0) {
        console.log(`Database ${config.database} already exists; no changes made.`);
        return;
      }

      // PostgreSQL identifiers cannot be bound parameters: quote and escape the name.
      const quotedName = '"' + config.database.replaceAll('"', '""') + '"';
      await connection.query(`CREATE DATABASE ${quotedName}`);
      console.log(`Created database ${config.database}.`);
      return;
    }

    console.log(`Connected to PostgreSQL: ${config.host}:${config.port}/${config.database}.`);
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof DatabaseConfigError) {
    console.error(error.message);
  } else {
    // Avoid printing connection objects or credentials in terminal output.
    console.error(
      "Database operation failed. Check that PostgreSQL is running and apps/api/.env matches DBeaver. " +
      "For db:create, the user needs permission to create databases. For db:check, the database must already exist.",
    );
  }
  process.exitCode = 1;
});
