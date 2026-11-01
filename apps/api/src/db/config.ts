export class DatabaseConfigError extends Error {}

export function readDatabaseConfig(env: NodeJS.ProcessEnv = process.env) {
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
  };
}

export type DatabaseConfig = ReturnType<typeof readDatabaseConfig>;
