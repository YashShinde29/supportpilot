// Public assessment credentials, never the owner's private account credentials.
// Keep in sync with apps/web/src/lib/demo-agent.ts.
process.env.AGENT_EMAIL = "demo@supportpilot.example";
process.env.AGENT_PASSWORD = "SupportPilotDemo!2026";
process.env.AGENT_NAME = "Demo Agent";

await import("./create-agent.js");
export {};
