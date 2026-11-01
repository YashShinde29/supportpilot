export class DatabaseConfigError extends Error {}

export function readDatabaseConfig(env: NodeJS.ProcessEnv = process.env, direct = false) {
  const connectionUrl = direct ? env.DATABASE_URL_UNPOOLED || env.DATABASE_URL : env.DATABASE_URL;
  if (connectionUrl?.trim()) {
    try {
      const url = new URL(connectionUrl);
      if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || url.pathname.length < 2) throw new Error();
      const port = Number(url.port || 5432);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
      if (direct && url.hostname.includes("-pooler.")) {
        throw new DatabaseConfigError("Set DATABASE_URL_UNPOOLED to the direct Neon connection for migrations and database tests.");
      }
      // Parse credentials separately so URL sslmode cannot override certificate verification.
      return {
        host: url.hostname, port, database: decodeURIComponent(url.pathname.slice(1)),
        username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), ssl: true,
      };
    } catch (error) {
      if (error instanceof DatabaseConfigError) throw error;
      throw new DatabaseConfigError("DATABASE_URL must be a valid PostgreSQL connection URL.");
    }
  }
  function required(name: string): string {
    const value = env[name];
    if (!value || value.trim() === "") {
      throw new DatabaseConfigError(`Set ${name} in apps/api/.env before using the database.`);
    }
    return value;
  }

  const rawPort = required("DB_PORT");
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DatabaseConfigError("DB_PORT must be an integer between 1 and 65535.");
  }

  return {
    host: required("DB_HOST"),
    port,
    database: required("DB_NAME"),
    username: required("DB_USER"),
    password: required("DB_PASSWORD"),
    ssl: false,
  };
}

export type DatabaseConfig = ReturnType<typeof readDatabaseConfig>;
