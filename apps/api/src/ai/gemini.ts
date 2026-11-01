import { GoogleGenAI, ApiError } from "@google/genai";
import { systemInstruction } from "./policies.js";
import { DraftProviderError, validateDraft, type DraftProvider } from "./provider.js";

export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

export function createGeminiProvider(): DraftProvider {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("Set GEMINI_API_KEY in apps/api/.env before starting the API.");
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const ai = new GoogleGenAI({ apiKey });

  return async (input) => {
    const signal = AbortSignal.timeout(20_000);
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: JSON.stringify({ history: input.history, customerMessage: input.message }) }] }],
        config: {
          systemInstruction,
          temperature: 0.2,
          maxOutputTokens: 512,
          ...(model.startsWith("gemini-2.5-") ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          abortSignal: signal,
          httpOptions: { timeout: 20_000, retryOptions: { attempts: 1 } },
        },
      });
      if (response.promptFeedback?.blockReason) throw new DraftProviderError("BLOCKED");
      const reason = response.candidates?.[0]?.finishReason;
      if (reason !== "STOP") throw new DraftProviderError(reason === "SAFETY" ? "BLOCKED" : "INVALID_RESPONSE");
      return validateDraft(response.text);
    } catch (error) {
      if (error instanceof DraftProviderError) throw error;
      if (signal.aborted) throw new DraftProviderError("TIMEOUT");
      if (error instanceof ApiError) {
        if (error.status === 429) throw new DraftProviderError("RATE_LIMITED");
        if (error.status === 401 || error.status === 403) throw new DraftProviderError("AUTH_ERROR");
        if (error.status === 404) throw new DraftProviderError("MODEL_UNAVAILABLE");
        if (error.status === 400) throw new DraftProviderError("AI_REQUEST_REJECTED");
      }
      // Never propagate SDK messages: they may contain request details or credentials.
      throw new DraftProviderError("PROVIDER_UNAVAILABLE");
    }
  };
}
