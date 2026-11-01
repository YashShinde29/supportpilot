import { Sequelize } from "sequelize";
import type { DatabaseConfig } from "./config.js";

export function createDatabaseConnection(config: DatabaseConfig, schema?: string) {
  return new Sequelize(config.database, config.username, config.password, {
    dialect: "postgres",
    host: config.host,
    port: config.port,
    logging: false,
    define: { schema },
    pool: { max: 5, min: 0, idle: 10_000, acquire: 10_000 },
    dialectOptions: { connectionTimeoutMillis: 5_000 },
    retry: { max: 0 },
  });
}
