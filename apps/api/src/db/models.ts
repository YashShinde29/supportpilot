import { randomUUID } from "node:crypto";
import {
  DataTypes, Model,
  type CreationOptional, type ForeignKey, type InferAttributes,
  type InferCreationAttributes, type Sequelize,
} from "sequelize";

export class Customer extends Model<InferAttributes<Customer>, InferCreationAttributes<Customer>> {
  declare id: CreationOptional<string>;
  declare externalId: string;
  declare name: string;
  declare phone: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class Agent extends Model<InferAttributes<Agent>, InferCreationAttributes<Agent>> {
  declare id: CreationOptional<string>;
  declare email: string;
  declare name: string;
  declare passwordHash: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class AgentSession extends Model<InferAttributes<AgentSession>, InferCreationAttributes<AgentSession>> {
  declare id: CreationOptional<string>;
  declare agentId: ForeignKey<Agent["id"]>;
  declare tokenHash: string;
  declare expiresAt: Date;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class Conversation extends Model<InferAttributes<Conversation>, InferCreationAttributes<Conversation>> {
  declare id: CreationOptional<string>;
  declare customerId: ForeignKey<Customer["id"]>;
  declare lastActivityAt: CreationOptional<Date>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class Message extends Model<InferAttributes<Message>, InferCreationAttributes<Message>> {
  declare id: CreationOptional<string>;
  declare conversationId: ForeignKey<Conversation["id"]>;
  declare sender: "customer" | "agent";
  declare text: string;
  declare sentAt: Date;
  declare externalId: string | null;
  declare eventId: string | null;
  declare agentId: ForeignKey<Agent["id"]> | null;
  declare replyToMessageId: ForeignKey<Message["id"]> | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class Draft extends Model<InferAttributes<Draft>, InferCreationAttributes<Draft>> {
  declare id: CreationOptional<string>;
  declare messageId: ForeignKey<Message["id"]>;
  declare status: CreationOptional<"pending" | "ready" | "failed" | "used">;
  declare text: string | null;
  declare errorCode: string | null;
  declare usedAt: Date | null;
  declare generationToken: string | null;
  declare generationStartedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

// Call once for the application's Sequelize connection. Schema changes are
// applied through migrations, never Model.sync() or sequelize.sync().
export function initializeModels(sequelize: Sequelize) {
  const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: () => randomUUID() };
  const timestamps = {
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  };
  const options = { sequelize, underscored: true, timestamps: true };

  Customer.init({
    id,
    externalId: { type: DataTypes.STRING(255), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(255), allowNull: false },
    phone: { type: DataTypes.STRING(32), allowNull: false },
    ...timestamps,
  }, { ...options, tableName: "customers" });

  Agent.init({
    id,
    email: { type: DataTypes.STRING(255), allowNull: false, unique: true, validate: { isEmail: true } },
    name: { type: DataTypes.STRING(255), allowNull: false },
    passwordHash: { type: DataTypes.TEXT, allowNull: false },
    ...timestamps,
  }, {
    ...options, tableName: "agents",
    defaultScope: { attributes: { exclude: ["passwordHash"] } },
    scopes: { withPassword: { attributes: { include: ["passwordHash"] } } },
  });

  AgentSession.init({
    id,
    agentId: { type: DataTypes.UUID, allowNull: false },
    tokenHash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    ...timestamps,
  }, { ...options, tableName: "agent_sessions" });

  Conversation.init({
    id,
    customerId: { type: DataTypes.UUID, allowNull: false, unique: true },
    lastActivityAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    ...timestamps,
  }, { ...options, tableName: "conversations" });

  Message.init({
    id,
    conversationId: { type: DataTypes.UUID, allowNull: false },
    sender: { type: DataTypes.STRING(16), allowNull: false, validate: { isIn: [["customer", "agent"]] } },
    text: { type: DataTypes.TEXT, allowNull: false },
    sentAt: { type: DataTypes.DATE, allowNull: false },
    externalId: { type: DataTypes.STRING(255), allowNull: true, unique: true },
    eventId: { type: DataTypes.STRING(255), allowNull: true, unique: true },
    agentId: { type: DataTypes.UUID, allowNull: true },
    replyToMessageId: { type: DataTypes.UUID, allowNull: true, unique: true },
    ...timestamps,
  }, { ...options, tableName: "messages" });

  Draft.init({
    id,
    messageId: { type: DataTypes.UUID, allowNull: false, unique: true },
    status: {
      type: DataTypes.STRING(16), allowNull: false, defaultValue: "pending",
      validate: { isIn: [["pending", "ready", "failed", "used"]] },
    },
    text: { type: DataTypes.TEXT, allowNull: true },
    errorCode: { type: DataTypes.STRING(100), allowNull: true },
    usedAt: { type: DataTypes.DATE, allowNull: true },
    generationToken: { type: DataTypes.UUID, allowNull: true },
    generationStartedAt: { type: DataTypes.DATE, allowNull: true },
    ...timestamps,
  }, { ...options, tableName: "drafts" });

  Customer.hasOne(Conversation, { foreignKey: "customerId", as: "conversation" });
  Agent.hasMany(AgentSession, { foreignKey: "agentId", as: "sessions" });
  AgentSession.belongsTo(Agent, { foreignKey: "agentId", as: "agent" });
  Conversation.belongsTo(Customer, { foreignKey: "customerId", as: "customer" });
  Conversation.hasMany(Message, { foreignKey: "conversationId", as: "messages" });
  Message.belongsTo(Conversation, { foreignKey: "conversationId", as: "conversation" });
  Agent.hasMany(Message, { foreignKey: "agentId", as: "messages" });
  Message.belongsTo(Agent, { foreignKey: "agentId", as: "agent" });
  Message.belongsTo(Message, { foreignKey: "replyToMessageId", as: "replyTo" });
  Message.hasOne(Message, { foreignKey: "replyToMessageId", as: "reply" });
  Message.hasOne(Draft, { foreignKey: "messageId", as: "draft" });
  Draft.belongsTo(Message, { foreignKey: "messageId", as: "message" });

  return { Customer, Agent, AgentSession, Conversation, Message, Draft };
}
