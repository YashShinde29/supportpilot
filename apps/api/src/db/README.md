# Database design

Run database commands from the repository root with PostgreSQL settings in `apps/api/.env`.

| Command | Purpose |
| --- | --- |
| `npm run db:check` | Authenticate to the configured database |
| `npm run db:migrate` | Apply pending schema migrations |
| `npm run db:status` | Show applied and pending migrations |
| `npm run db:verify` | Verify models and constraints using rolled-back sample rows |

## Tables

| Table | Responsibility and relationships |
| --- | --- |
| `customers` | Unique external customer ID, name, and phone |
| `conversations` | Unique customer reference and last activity time |
| `messages` | Conversation reference, sender, text, sent time; incoming external/event IDs or approving agent and reply target |
| `drafts` | Unique incoming-message reference, generated text, status, safe error code, and use timestamp |
| `agents` | Name, normalized lowercase email, and password hash |
| `agent_sessions` | Hashed opaque session token, agent reference, and absolute expiry |
| `login_attempts` | Hashed normalized login address, count, and rate-limit window |
| `SequelizeMeta` | Migration history maintained by Umzug |

Each table has a UUID primary key and creation/update timestamps. Models expose camelCase properties; database columns use snake_case. PostgreSQL stores timestamps with time zones.

This version supports one brand and one continuing conversation per customer, matching the assessment. Conversation closing and multi-brand administration are outside the current scope. Phone numbers are not used as unique customer identities; webhook customer IDs are.

## Data integrity

- Unique customer references prevent two conversations for the same customer.
- Unique webhook event IDs and external message IDs protect idempotent ingestion, including concurrent retries. The ingestion service handles duplicate conflicts.
- A draft belongs to one incoming message. Only one draft row can exist per message; retries update that row.
- Incoming customer messages require external and event IDs. Agent replies require an agent and a reply target.
- A unique reply target permits at most one approved reply per incoming message. A composite foreign key keeps that reply in the same conversation.
- Foreign keys prevent orphaned records. Deleting referenced records is restricted.
- Conversation activity and message ordering have supporting indexes. Message IDs provide a deterministic tie-breaker when timestamps match.

Draft states:

| State | Required data |
| --- | --- |
| `pending` | No text, error, or use timestamp |
| `ready` | Nonblank generated text, no error or use timestamp |
| `failed` | Safe error code, no text or use timestamp |
| `used` | Nonblank draft text and use timestamp |

Migration `002-draft-generation-lease` adds `generation_token` and `generation_started_at`. Only a pending draft may hold them, and both must be set or cleared together. A conditional update claims work; a matching token is required to save a result. This prevents simultaneous retries or stale workers from overwriting a newer draft. No database transaction is held open during the provider call.

The approval service locks the draft and conversation, inserts the approved message, marks its draft used, and updates activity in one transaction. It validates that the source is a customer message and the draft is ready. Approved edits live in the reply message, allowing the generated draft to remain available internally.

Agent queries exclude password hashes by default. Authentication explicitly requests `Agent.scope("withPassword")` and serializes only a safe public profile. `npm run agent:create` seeds an account using local environment settings. Migration 003 adds hashed sessions and persistent login throttling; application tables and existing messages are preserved.

## Files and migrations

## Neon connections

`neon deploy` writes `DATABASE_URL` (pooled), `DATABASE_URL_UNPOOLED` (direct), and `NEON_BRANCH` to the ignored root `.env.local` (or root `.env` when present). API scripts load `apps/api/.env`, root `.env`, then root `.env.local`; existing process variables take precedence. Database URLs take precedence over local `DB_*` settings. Keep the Gemini key, webhook secret and seed-account settings in `apps/api/.env` for local runs. Never use `NEXT_PUBLIC_` for database credentials.

The Fastify Node runtime retains Sequelize with `pg`. URL connections require TLS with certificate validation. The existing local `DB_*` configuration keeps working without TLS when no URL is set. Migrations, schema verification and integration tests use the direct URL; application traffic uses the pooled URL. Tests create and remove only their randomly named test schemas.

After connecting a new database, run `npm run db:migrate`, `npm run db:verify`, and `npm run agent:create`, then start the API and frontend. Migrations are an explicit deployment step, never an API-startup operation. Set both database URLs in the backend hosting environment when deploying Fastify. Neon provisioning does not publish the Next.js or Fastify application.

To return to local PostgreSQL, remove the Neon URL variables from the runtime environment (for example, move the ignored root `.env.local` outside the workspace); the original `apps/api/.env` values are retained. Local conversations are not copied to Neon.

## Migration files

- `models.ts` declares and initializes the five typed models and associations. Initialize them once for the application's Sequelize connection.
- `migrations/001-initial-schema.ts` defines the initial PostgreSQL schema independently of model code. Its table creation runs in a transaction.
- `migrator.ts` registers migrations explicitly, so the same imports work through TypeScript and in compiled JavaScript.
- `migrate.ts` exposes apply/status commands. Run migrations as a separate deployment step, never automatically on API startup. Run only one migration process at a time.
- `verify.ts` exercises actual PostgreSQL constraints using savepoints and rolls back all fixture rows, including on failure. It never resets or drops tables.

Add a new migration for later schema changes; do not edit a migration already applied. No `sync({ alter: true })` or `sync({ force: true })` is used. A reverse definition is included for migration tooling, but no destructive rollback command is exposed or run here.
