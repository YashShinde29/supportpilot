import { Sequelize } from "sequelize";
import pg from "pg";
import type { DatabaseConfig } from "./config.js";

export function createDatabaseConnection(config: DatabaseConfig, schema?: string) {
  return new Sequelize(config.database, config.username, config.password, {
    dialect: "postgres",
    // Explicit import lets deployment bundlers trace Sequelize's database driver.
    dialectModule: pg,
    host: config.host,
    port: config.port,
    logging: false,
    define: { schema },
    pool: { max: 5, min: 0, idle: 10_000, acquire: 10_000 },
    dialectOptions: {
      connectionTimeoutMillis: 10_000,
      ...(config.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    },
    retry: { max: 0 },
  });
}
