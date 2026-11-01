import type { Sequelize } from "sequelize";
import { SequelizeStorage, Umzug } from "umzug";
import * as initialSchema from "./migrations/001-initial-schema.js";
import * as draftGenerationLease from "./migrations/002-draft-generation-lease.js";
import * as agentSessions from "./migrations/003-agent-sessions.js";

export function createMigrator(db: Sequelize, schema?: string) {
  return new Umzug({
    migrations: [
      { name: "001-initial-schema", ...initialSchema },
      { name: "002-draft-generation-lease", ...draftGenerationLease },
      { name: "003-agent-sessions", ...agentSessions },
    ],
    context: db,
    storage: new SequelizeStorage({ sequelize: db, schema }),
    logger: undefined,
  });
}
