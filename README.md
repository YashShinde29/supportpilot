# SupportPilot

A customer support application for the Datastraw take-home assessment, built incrementally for Verdant & Co.

## Current phase

Customer and agent screens, signed webhooks, Gemini drafts, authenticated approval, and PostgreSQL persistence are implemented. Neon PostgreSQL is connected; public frontend/backend hosting is the next deployment step.

## Neon database

`neon.ts` declares PostgreSQL-only infrastructure, retaining our Fastify authentication and Gemini integration. `npx neon@latest deploy` pulls database URLs into the ignored root `.env.local`. API scripts load these settings automatically: pooled `DATABASE_URL` for requests and direct `DATABASE_URL_UNPOOLED` for migrations/tests, with verified TLS. See [connection details](apps/api/src/db/README.md).

Run `npm run db:migrate`, `npm run db:verify`, then `npm run agent:create` for a new database. The existing API `.env` supplies the agent credentials and Gemini key; keep all environment files out of Git. Restart an already-running API after adding or changing environment files. Neon setup does not upload local database conversations or deploy the web/API servers.

The end-to-end smoke script uses a running API on port 4101 by default (override `SMOKE_API_URL`). After building and starting that API, run:

```sh
node --env-file=apps/api/.env --env-file=.env.local scripts/neon-smoke.mjs
```

This makes a real Gemini call, verifies login, duplicate intake, private drafts, edited approval, public replies, Neon persistence, and TLS. It leaves a fictional Meera message/reply for review and logs out its test session. Use an isolated environment for repeated smoke runs. The automated agent/webhook suites instead use temporary schemas and fake AI responses.

Neon's separate skill installer requires Node.js 22.20 or newer. The Neon plugin's bundled skills were available and used during setup; the app itself builds on the existing Node.js 22.14 runtime.

## Run locally

Use Node.js 22 and npm 10 or later. From the repository root:

```sh
npm ci
```

Run these commands in two terminals:

```sh
npm run dev:web
```

```sh
npm run dev:api
```

Open http://localhost:3000 for the frontend and http://localhost:3001/health for the API. The health endpoint returns `{"status":"ok"}` and currently checks only whether the API is running.

The frontend starter works independently. Before starting the API, copy `apps/api/.env.example` to `apps/api/.env` if it does not exist, enter database settings/password and `GEMINI_API_KEY`, and complete database setup below. Set `WEB_ORIGIN` to the exact frontend origin (`http://localhost:3000` locally; HTTPS in production). The API requires `WEBHOOK_SECRET` (the assessment's demo value is in the example). `GEMINI_MODEL` defaults to tested free-tier `gemini-3.1-flash-lite`; keep billing disabled for free-only use. Environment files are ignored by Git.

## Local database

The selected local server is `127.0.0.1:5433`, with application user `supportpilot_app` and a dedicated database named `supportpilot`. DBeaver is the client used to inspect that PostgreSQL server. Change the example values if your server differs.

One-time setup: use an administrator connection in DBeaver with auto-commit enabled. Replace the password placeholder locally, then execute each statement separately:

```sql
CREATE ROLE supportpilot_app LOGIN PASSWORD 'REPLACE_WITH_YOUR_CHOSEN_PASSWORD';
CREATE DATABASE supportpilot OWNER supportpilot_app;
```

Put that same chosen password in `DB_PASSWORD` in `apps/api/.env`, then run from the project root:

```sh
npm run db:check
npm run db:migrate
npm run db:verify
```

`db:migrate` applies pending migrations; `db:status` lists their state. `db:verify` checks the schema using temporary rows that are rolled back. The optional `db:create` command requires database-creation privileges; the application user does not need them because the administrator creates its database. Local connections currently use no TLS; hosted TLS will be configured during deployment. See [database design](apps/api/src/db/README.md) for tables and constraints.

Set `AGENT_EMAIL`, `AGENT_NAME`, and a 12–128 character `AGENT_PASSWORD` locally, then run `npm run agent:create`. This creates one agent and never changes an existing account. Sessions use HTTP-only cookies; passwords use salted scrypt hashes. See [agent API and authentication](apps/api/src/auth/README.md). The Agent tab provides the login screen.

## Structure and checks

With the API running, `npm run webhook:send` sends a sample twice: expect 201, then 200 with the same message ID. The message and its draft remain in PostgreSQL. `npm run test:webhook` tests real PostgreSQL with a fake AI provider in a temporary schema, then removes that schema. `npm run ai:check` makes one live Gemini request; `npm run ai:samples` checks the five assessment questions. To retry a failed or abandoned draft: `npm run ai:retry -- <message-uuid>`. See [webhook details](apps/api/src/webhooks/README.md) and [AI design](apps/api/src/ai/README.md).

- `apps/web/src/app`: Next.js App Router pages, root layout, and Tailwind styles.
- `apps/api/src/build-app.ts`: constructs the Fastify app independently of its HTTP listener.
- `apps/api/src/server.ts`: starts the API and handles shutdown.
- `apps/api/src/db`: connection settings, typed models, explicit migrations, and database verification.
- `apps/api/src/webhooks` and `src/messages`: signed HTTP intake and the shared transactional ingestion service.
- `apps/api/src/ai`: assessment policies, Gemini client, generation/recovery service, and local check commands.
- `apps/api/src/auth` and `src/agent`: sessions, account creation, protected conversation reads, approval, and draft retry.
- `tsconfig.base.json`: shared strict TypeScript settings.
- Root `package.json` and `package-lock.json`: npm workspaces and reproducible dependencies.

Run `npm run typecheck` and `npm run build` from the root. After building, use `npm run start --workspace=@supportpilot/web` and `npm run start --workspace=@supportpilot/api` in separate terminals to run the production builds.

`npm run test:agent` verifies auth, origin checks, session expiry/revocation, pagination, concurrent approval, and rollback in an isolated PostgreSQL schema with no real AI calls.

Sequelize's transitive `uuid` dependency is pinned to patched CommonJS-compatible version 11.1.1 via a scoped npm override (GHSA-w5hq-g745-h8pq). Revisit this override when upgrading Sequelize.

The Customer/Agent screens are available at http://localhost:3000. Start `npm run dev:api` and `npm run dev:web` in separate terminals. Select a fictional customer, send a message, switch to Agent, sign in with the locally seeded account, edit a draft and approve it. Switch back to Customer to see the reply. Views refresh every five seconds; drafts are never returned by public customer endpoints. Public demo identities are intentionally shared and are not customer authentication.

Next.js proxies `/api/*` to Fastify (default `http://127.0.0.1:3001`). Set server-only `API_BASE_URL` in `apps/web/.env.local` to override this before building. Keep API `WEB_ORIGIN=http://localhost:3000` for local browser requests. Secrets stay in the API environment. Components live in `apps/web/src/components`, the typed client in `src/lib`, and public demo routes in `apps/api/src/customer`. Customer sends reuse their request ID on retry, and use the webhook's ingestion and draft service.

Next phase: deployment and browser end-to-end checks. Hosting configuration, managed PostgreSQL and public-demo abuse controls must be reviewed before publishing.

This README will be finalized with assessment decisions, omissions, AI-tool disclosure, and the two required answers as the application is completed.
