# SupportPilot

AI-assisted customer support for Verdant & Co: Next.js/React/TypeScript and Tailwind in `apps/web`, Fastify/TypeScript in `apps/api`, PostgreSQL via Sequelize, and Gemini for drafts. Agents review and edit every reply before approval; nothing is automatically sent to the customer.

## Run locally

Requires Node.js 22, npm 10+, PostgreSQL, and a Gemini API key.

1. Run `npm ci` from the repository root.
2. Create a PostgreSQL database named `supportpilot` owned by your application user. Copy `apps/api/.env.example` to `apps/api/.env` and set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, and `GEMINI_API_KEY`; the example uses port `5433`, so adjust it to your server. Keep `WEB_ORIGIN=http://localhost:3000` and the assessment webhook secret from the example.
3. Run:
   ```sh
   npm run db:migrate
   npm run agent:create-demo --workspace=@supportpilot/api
   ```
4. Start `npm run dev:api` and `npm run dev:web` in separate terminals, then open http://localhost:3000.

The Agent screen displays the shared demo login. To create a private agent instead, set `AGENT_EMAIL`, `AGENT_NAME`, and a 12–128-character `AGENT_PASSWORD` in the API environment, then run `npm run agent:create`. Use fictional data: demo agents share access to conversations.

For Neon, root `.env.local` can supply pooled `DATABASE_URL` and direct `DATABASE_URL_UNPOOLED` instead of local `DB_*` settings; URLs take precedence and use verified TLS. Remove those URL settings when switching back to local PostgreSQL, and never commit environment files.

Checks: `npm run typecheck`, `npm run build`, `npm run test:webhook`, and `npm run test:agent`. Integration tests use temporary PostgreSQL schemas and a fake AI provider; with the API running, `npm run webhook:send` tests a signed delivery and duplicate retry using real Gemini.


## 1. What happens if something fails at 2 a.m.?

If the message was committed before AI generation failed, the agent sees it with a failed draft and a retry button; an interrupted generation can remain pending and be retried after its lease expires. If ingestion failed before commit, no message appears, and recovery depends on the sender retrying the non-successful webhook response—there is no durable queue or automatic recovery worker yet. I would correlate request/event/message IDs in API logs with the stored draft status/error code, check database and provider availability, and retry after fixing the cause; alerts are a next improvement.

## 2. What would change for 20 brands?

First, introduce brands and agent memberships, scope customers/conversations/messages/drafts and uniqueness constraints by brand, and enforce brand access in every API query. Store each brand's knowledge base and webhook secret separately, resolve the brand from verified webhook credentials or authorized agent context, and load only that brand's policies for AI generation. Tenant isolation comes first to prevent cross-brand data exposure; tests should prove agents cannot read or approve another brand's conversations.
