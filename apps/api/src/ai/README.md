# Gemini drafts

## Configuration

Set `GEMINI_API_KEY` in the ignored `apps/api/.env`. The tested model is `gemini-3.1-flash-lite`; `GEMINI_MODEL` can override it explicitly. The earlier `gemini-2.5-flash` appeared in the model list but returned 404 on generation, so it was not retained as the default. No automatic model fallback or billing change is made.

Google lists Flash-Lite on its [free tier](https://ai.google.dev/gemini-api/docs/pricing). Quotas and project eligibility apply, and the free tier may use submitted content to improve Google's products. Keep assessment data fictional and billing disabled if you want free-only usage. A key lookup alone does not prove inference works; `ai:check` makes an actual generation request.

## Prompt and output

`policies.ts` contains the assessment's seven policies in full. For this small fixed knowledge base, including all policies in the system instruction is simpler than retrieval or embeddings. Revisit retrieval when policies become large, frequently edited, or brand-specific.

The provider receives the current message and at most eight earlier messages (each history item capped at 2,000 characters). No customer name, phone field, IDs, or unapproved drafts are included. Customer-written text may itself contain personal details. Conversation text is labeled as untrusted data, and previous replies cannot override brand policies.

Instructions require short plain-text replies, exact policy conditions, uncertainty for missing policy information, and no invented order status or completed actions. A suspected allergy is handled empathetically without diagnosis, treatment, or an allergy-safe claim. Only nonempty, complete model outputs of at most 4,000 characters are stored; blocked, truncated, or malformed outputs fail safely. These checks do not prove factual accuracy, so human review remains required.

## Execution and recovery

1. `messages/receive.ts` commits customer/message storage first.
2. `generate-draft.ts` claims a pending draft with a unique token and timestamp in an atomic update.
3. Gemini is called outside a transaction, with a 20-second timeout, one attempt, and a 512-token output limit. Requests are awaited rather than launched as untracked background promises.
4. Success sets `ready` and stores the text. Provider failure sets `failed` and stores only a safe error code (`RATE_LIMITED`, `AUTH_ERROR`, `MODEL_UNAVAILABLE`, `TIMEOUT`, `BLOCKED`, `INVALID_RESPONSE`, `AI_REQUEST_REJECTED`, or `PROVIDER_UNAVAILABLE`).
5. Only the current token holder may update the draft. A claim older than 60 seconds can be reclaimed after a crash; an older response cannot overwrite recovery. Ready/used drafts are never regenerated.

The webhook acknowledges persisted messages even when AI fails. Duplicate deliveries skip failed drafts to avoid repeated quota consumption. Explicit recovery uses authenticated `POST /agent/drafts/:id/retry` or local `npm run ai:retry -- <message-uuid>` for failed or abandoned pending drafts. There is no durable queue or automatic recovery scheduler yet: after a process interruption, a later duplicate delivery or explicit retry resumes work. If final database persistence fails, the request returns 500 and the pending lease can later recover.

This small deployment uses bounded request-time generation. We will configure hosting to allow the provider timeout plus database overhead. Higher throughput would warrant a durable queue and worker with backoff, rather than extending HTTP timeouts.

## Verification

- `npm run ai:check`: one live return-policy question.
- `npm run ai:samples`: five live fictional assessment questions, consuming free-tier quota.
- `npm run ai:check --workspace=@supportpilot/api -- --sample=3`: recheck only the Dubai example.
- `npm run test:webhook`: real PostgreSQL with a fake provider; no Gemini requests. Includes generation, quota/time-out/block failures, explicit retry, invalid output, concurrent claims, and stale-worker recovery.

Live review found that the first Dubai reply falsely claimed an inquiry had been forwarded. The prompt was tightened to prohibit forwarding/escalation/follow-up claims and the recheck acknowledged uncertainty without claiming any action. This is a useful example for the assessment's AI-tool/limitations discussion; it does not guarantee all future outputs are correct.
