import type { Sequelize } from "sequelize";

// Keep migration definitions independent of models so later model edits cannot
// change the meaning of a migration already applied to another database.
export async function up({ context: db }: { context: Sequelize }) {
  await db.transaction(async (transaction) => {
    await db.query(`
      CREATE TABLE customers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        external_id VARCHAR(255) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL CHECK (btrim(name) <> ''),
        phone VARCHAR(32) NOT NULL CHECK (btrim(phone) <> ''),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE agents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) NOT NULL UNIQUE CHECK (email = lower(email) AND btrim(email) <> ''),
        name VARCHAR(255) NOT NULL CHECK (btrim(name) <> ''),
        password_hash TEXT NOT NULL CHECK (btrim(password_hash) <> ''),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id UUID NOT NULL UNIQUE REFERENCES customers(id) ON DELETE RESTRICT,
        last_activity_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX conversations_activity_idx ON conversations(last_activity_at DESC, id);

      CREATE TABLE messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
        sender VARCHAR(16) NOT NULL CHECK (sender IN ('customer', 'agent')),
        text TEXT NOT NULL CHECK (btrim(text) <> ''),
        sent_at TIMESTAMPTZ NOT NULL,
        external_id VARCHAR(255) UNIQUE,
        event_id VARCHAR(255) UNIQUE,
        agent_id UUID REFERENCES agents(id) ON DELETE RESTRICT,
        reply_to_message_id UUID UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (id, conversation_id),
        CONSTRAINT messages_reply_conversation_fk
          FOREIGN KEY (reply_to_message_id, conversation_id)
          REFERENCES messages(id, conversation_id) ON DELETE RESTRICT,
        CONSTRAINT messages_sender_fields_check CHECK (
          (sender = 'customer' AND external_id IS NOT NULL AND btrim(external_id) <> ''
            AND event_id IS NOT NULL AND btrim(event_id) <> ''
            AND agent_id IS NULL AND reply_to_message_id IS NULL)
          OR
          (sender = 'agent' AND external_id IS NULL AND event_id IS NULL
            AND agent_id IS NOT NULL AND reply_to_message_id IS NOT NULL)
        )
      );
      CREATE INDEX messages_conversation_time_idx ON messages(conversation_id, sent_at, id);

      CREATE TABLE drafts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        message_id UUID NOT NULL UNIQUE REFERENCES messages(id) ON DELETE RESTRICT,
        status VARCHAR(16) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'ready', 'failed', 'used')),
        text TEXT,
        error_code VARCHAR(100),
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT drafts_text_check CHECK (
          (status IN ('ready', 'used') AND text IS NOT NULL AND btrim(text) <> '')
          OR (status IN ('pending', 'failed') AND text IS NULL)
        ),
        CONSTRAINT drafts_error_check CHECK (
          (status = 'failed' AND error_code IS NOT NULL AND btrim(error_code) <> '')
          OR (status <> 'failed' AND error_code IS NULL)
        ),
        CONSTRAINT drafts_used_check CHECK (
          (status = 'used' AND used_at IS NOT NULL)
          OR (status <> 'used' AND used_at IS NULL)
        )
      );
    `, { transaction });
  });
}

// Destructive: expose rollback only through an explicit command, never startup.
export async function down({ context: db }: { context: Sequelize }) {
  await db.transaction(async (transaction) => {
    await db.query(`
      DROP TABLE drafts;
      DROP TABLE messages;
      DROP TABLE conversations;
      DROP TABLE agents;
      DROP TABLE customers;
    `, { transaction });
  });
}
