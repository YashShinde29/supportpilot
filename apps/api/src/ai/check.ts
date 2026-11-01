import { createGeminiProvider, DEFAULT_GEMINI_MODEL } from "./gemini.js";
import { DraftProviderError } from "./provider.js";

const samples = [
  "Hi, my order #4471 hasn't arrived yet. Can I change the delivery address?",
  "What is your return policy?",
  "Do you deliver to Dubai?",
  "Is cash on delivery available for a ₹3,500 order?",
  "I think I'm allergic to the serum I bought. What should I do?",
];

async function main() {
  const generate = createGeminiProvider();
  console.log(`Checking ${process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL} with fictional assessment messages.`);
  const selected = process.argv.find((arg) => arg.startsWith("--sample="));
  const index = selected ? Number(selected.split("=")[1]) - 1 : 1;
  if (!Number.isInteger(index) || !samples[index]) throw new Error("Choose a sample from 1 to 5.");
  const inputs = process.argv.includes("--samples") ? samples : [samples[index]!];
  for (const message of inputs) {
    const reply = await generate({ message, history: [] });
    console.log(JSON.stringify({ message, reply }));
  }
}

main().catch((error: unknown) => {
  console.error(`Gemini check failed: ${error instanceof DraftProviderError ? error.code : "CONFIGURATION_ERROR"}.`);
  process.exitCode = 1;
});
