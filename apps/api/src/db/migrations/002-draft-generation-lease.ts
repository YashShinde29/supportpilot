import type { Sequelize } from "sequelize";

export async function up({ context: db }: { context: Sequelize }) {
  await db.transaction(async (transaction) => {
    await db.query(`ALTER TABLE drafts
      ADD COLUMN generation_token UUID,
      ADD COLUMN generation_started_at TIMESTAMPTZ,
      ADD CONSTRAINT drafts_generation_lease_check CHECK (
        (generation_token IS NULL AND generation_started_at IS NULL)
        OR (status = 'pending' AND generation_token IS NOT NULL AND generation_started_at IS NOT NULL)
      )`, { transaction });
  });
}

export async function down({ context: db }: { context: Sequelize }) {
  await db.query(`ALTER TABLE drafts DROP CONSTRAINT drafts_generation_lease_check,
    DROP COLUMN generation_token, DROP COLUMN generation_started_at`);
}
