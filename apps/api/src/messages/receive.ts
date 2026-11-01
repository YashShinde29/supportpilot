import type { Sequelize } from "sequelize";
import type { IncomingMessageEvent } from "../webhooks/schema.js";
import type { DraftProvider } from "../ai/provider.js";
import { generateDraft } from "../ai/generate-draft.js";
import { ingestMessage } from "./ingest.js";

// Both webhook delivery and the Customer view use this flow after input
// validation. The message transaction commits before the provider is called.
export async function receiveMessage(db: Sequelize, event: IncomingMessageEvent, provider: DraftProvider) {
  const message = await ingestMessage(db, event);
  const draft = await generateDraft(message.messageId, provider);
  return { message, draft };
}
