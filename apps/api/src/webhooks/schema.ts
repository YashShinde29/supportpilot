export interface IncomingMessageEvent {
  event_id: string;
  type: "message.received";
  brand_id: "verdant-co";
  timestamp: string;
  customer: { id: string; name: string; phone: string };
  message: { id: string; type: "text"; text: string };
}

const identifier = { type: "string", minLength: 1, maxLength: 255, pattern: "^[^\\s\\u0000]+$" };
const nonblankText = { type: "string", minLength: 1, allOf: [{ pattern: "\\S" }, { pattern: "^[^\\u0000]*$" }] };

export const incomingMessageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["event_id", "type", "brand_id", "timestamp", "customer", "message"],
  properties: {
    event_id: identifier,
    type: { const: "message.received" },
    brand_id: { const: "verdant-co" },
    timestamp: { type: "string", format: "date-time", maxLength: 64 },
    customer: {
      type: "object", additionalProperties: false, required: ["id", "name", "phone"],
      properties: {
        id: identifier,
        name: { ...nonblankText, maxLength: 255 },
        phone: { ...nonblankText, maxLength: 32 },
      },
    },
    message: {
      type: "object", additionalProperties: false, required: ["id", "type", "text"],
      properties: {
        id: identifier,
        type: { const: "text" },
        text: { ...nonblankText, maxLength: 10_000 },
      },
    },
  },
} as const;

export const webhookResponseSchema = {
  type: "object", additionalProperties: false,
  required: ["status", "messageId", "conversationId"],
  properties: {
    status: { type: "string", enum: ["accepted", "duplicate"] },
    messageId: { type: "string" },
    conversationId: { type: "string" },
  },
} as const;
