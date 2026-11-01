import type { Sequelize } from "sequelize";

export async function up({ context: db }: { context: Sequelize }) {
  await db.transaction(async (transaction) => {
    await db.query(`
      CREATE TABLE agent_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        token_hash CHAR(64) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX agent_sessions_expiry_idx ON agent_sessions(expires_at);
      CREATE INDEX agent_sessions_agent_idx ON agent_sessions(agent_id);
      CREATE TABLE login_attempts (
        key_hash CHAR(64) PRIMARY KEY,
        attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
        window_started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX login_attempts_window_idx ON login_attempts(window_started_at);
    `, { transaction });
  });
}

export async function down({ context: db }: { context: Sequelize }) {
  await db.transaction(async (transaction) => {
    await db.query("DROP TABLE login_attempts; DROP TABLE agent_sessions;", { transaction });
  });
}
