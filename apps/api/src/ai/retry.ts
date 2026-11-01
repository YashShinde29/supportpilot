import { readDatabaseConfig } from "../db/config.js";
import { createDatabaseConnection } from "../db/connection.js";
import { initializeModels } from "../db/models.js";
import { generateDraft } from "./generate-draft.js";
import { createGeminiProvider } from "./gemini.js";

async function main() {
  const id = process.argv[2];
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("A message UUID is required.");
  }
  const provider = createGeminiProvider();
  const db = createDatabaseConnection(readDatabaseConfig());
  const { Draft } = initializeModels(db);
  try {
    if (!await Draft.findOne({ where: { messageId: id } })) throw new Error("Draft not found.");
    const result = await generateDraft(id, provider, true);
    console.log(JSON.stringify({ messageId: id, ...result }));
    if (result.outcome === "failed") process.exitCode = 1;
  } finally {
    await db.close();
  }
}

main().catch(() => {
  console.error("Draft retry failed. Provide a valid message UUID and check database/Gemini configuration.");
  process.exitCode = 1;
});
