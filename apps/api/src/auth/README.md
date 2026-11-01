# Agent authentication and APIs

## Account setup

After `npm run db:migrate`, set `AGENT_EMAIL`, optional `AGENT_NAME`, and a 12–128 character `AGENT_PASSWORD` in the ignored `apps/api/.env`, then run `npm run agent:create`. The command normalizes the email, creates an account only if absent, and never overwrites an existing account's credentials. There is no public signup or default password. These environment values are used by the setup command, not by login requests; the saved account remains usable if they are removed later.

Passwords use Node's async scrypt with a random 16-byte salt, N=32768, r=8, p=3, and a 64-byte derived key. This is one of [OWASP's recommended scrypt configurations](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Unknown accounts still perform scrypt work and receive the same error as an incorrect password. Hashes are excluded from ordinary agent queries and all response DTOs.

## Browser/session boundary

- `POST /auth/login` accepts `{ "email": "...", "password": "..." }`. It returns the public agent and expiry, and sets a random 256-bit session token in an HTTP-only, SameSite=Lax, Path=/ cookie. Only a SHA-256 hash of that high-entropy token is saved in PostgreSQL.
- Sessions expire after 12 hours. Re-login revokes the cookie's old session and issues a new token. Logout deletes the current session. Expired records are cleaned up on login.
- Production uses a Secure `__Host-supportpilot_session` cookie without a Domain attribute. Development uses `supportpilot_session` so local HTTP works.
- All agent/auth responses use `Cache-Control: no-store`.
- Every non-GET/HEAD request in the auth/agent API requires an `Origin` header exactly matching `WEB_ORIGIN`. This also protects login/logout against CSRF. Production requires an HTTPS frontend origin. Missing or wrong origins return 403, even with a valid cookie.
- The upcoming frontend will call same-origin `/api/...` URLs through a Next.js proxy to Fastify. No permissive cross-origin cookie/CORS configuration is added. The backend remains independently protected even when accessed directly.
- External webhooks are in a separate Fastify plugin, authenticated by HMAC instead of agent cookies or browser origin checks.

Login is limited to ten attempts per normalized email per 15-minute window. Counters cover known and unknown accounts and persist in PostgreSQL, so restarting or changing backend instances cannot reset the limit. Successful attempts also count. HTTP 429 indicates the limit; old counter records are cleaned up after a day. This is account-level brute-force protection; broader traffic/CPU abuse controls belong at the hosting boundary when deploying.

## Endpoints

| Method and path | Behavior |
| --- | --- |
| `POST /auth/login` | Authenticate and set cookie; 401 for invalid credentials, 429 when limited |
| `GET /auth/me` | Public profile of the signed-in agent |
| `POST /auth/logout` | Revoke current session, clear cookie, return 204 |
| `GET /agent/conversations?limit=20&offset=0` | Newest activity first, with customer and latest message preview |
| `GET /agent/conversations/:id?limit=100&offset=0` | Conversation and latest page of messages/drafts, displayed oldest to newest |
| `POST /agent/drafts/:id/approve` | Save edited `{ "text": "..." }` as an agent reply and mark draft used |
| `POST /agent/drafts/:id/retry` | Retry failed or abandoned pending generation; active pending attempts return 202 |

All endpoints except login require a valid session. Read pagination limits range from 1 to 100. Message order uses arrival (`created_at`) time with UUID as a tie-breaker, so an approved reply follows its customer message even when the assessment payload has a future sent timestamp. The original `sent_at` remains available in each message. There are no customer endpoints in this phase; customers must not receive these draft-containing responses.

## Approval and retry rules

Approval locks the draft and conversation inside a database transaction, inserts the edited reply with the approving agent ID, marks the draft used, and updates conversation activity. The original generated text remains on the draft. Any failure rolls back all changes. Pending/failed drafts cannot be approved.

A repeated approval with the same text returns 200 and the existing reply. A competing approval with different text returns 409. A unique reply target in PostgreSQL provides an additional guarantee against duplicates. No external chat message is sent: saving the approved reply fulfills the assessment.

Retry is authenticated and origin-checked, and it uses the same generation lease as webhook processing. Ready/used drafts return 409; provider failures remain visible as failed drafts with safe error codes. Responses omit generation tokens, raw errors, session tokens, and password hashes.

## Tests

`npm run test:agent` uses random fixture credentials and a dedicated temporary database schema, then removes that schema. It covers anonymous/forged sessions, generic login failures, production cookie flags and hashed storage, origin checks, read pagination, concurrent/idempotent approval, draft retry, transaction rollback, persistent login limits, rotation, expiry, and logout. No real account data or Gemini quota is used.
