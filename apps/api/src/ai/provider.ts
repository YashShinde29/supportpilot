export interface DraftInput {
  message: string;
  history: Array<{ sender: "customer" | "agent"; text: string }>;
}

export type DraftProvider = (input: DraftInput) => Promise<string>;

export type DraftErrorCode = "RATE_LIMITED" | "AUTH_ERROR" | "MODEL_UNAVAILABLE" |
  "PROVIDER_UNAVAILABLE" | "TIMEOUT" | "BLOCKED" | "INVALID_RESPONSE" | "AI_REQUEST_REJECTED";

export class DraftProviderError extends Error {
  constructor(public readonly code: DraftErrorCode) {
    super(code);
    this.name = "DraftProviderError";
  }
}

export function validateDraft(text: unknown): string {
  if (typeof text !== "string" || !text.trim() || text.length > 4_000 || text.includes("\u0000")) {
    throw new DraftProviderError("INVALID_RESPONSE");
  }
  return text.trim();
}
