# SERVIA AI Customer Service Agent

A backend that answers prospective SERVIA clients on **WhatsApp**, **Instagram** and **Facebook Messenger**.
Replies are grounded in an editable knowledge base: it does not invent prices or facts, and it hands
conversations to the SERVIA team when it should.
No workflow platforms (n8n, Zapier, Make): all logic lives in this service.

> **Channel status:** all three adapters are implemented and covered by automated tests with mocked Meta APIs.
> **None has been verified end-to-end with real Meta credentials yet.** Treat them as "ready for setup",
> not "live", until you complete the checklist in [docs/CHANNEL_SETUP.md](docs/CHANNEL_SETUP.md).

## What it does

- Receives Meta webhooks.
  - Verifies the subscription handshake and the `X-Hub-Signature-256` signature against the raw body.
  - Normalizes each channel's payload into one internal message format.
- Stores contacts, conversations and messages in PostgreSQL.
  - Duplicate webhook deliveries never create duplicate messages or replies.
- Retrieves relevant passages from the knowledge base using PostgreSQL full-text search (Arabic + English normalization).
- Asks the model (OpenAI Responses API) for a structured reply, then validates it.
  - Unknown source IDs are dropped.
  - Prices not present in the knowledge base are blocked.
  - Prompt leaks are blocked.
  - If anything fails, it falls back to a safe "the team will follow up" reply.
- Sends the reply on the same channel through a PostgreSQL-backed job queue.
  - Retries transient failures with exponential backoff.
  - A retry never generates a second reply.
- Hands conversations to a human when asked, when pricing, contracts or meetings come up, or when knowledge is missing.
  - After handoff the bot stays silent in that conversation until an admin reopens it.

It does **not** book meetings, access calendars, send outbound/cold messages, negotiate, promise results, or give medical advice.

## Quick start (local, no credentials needed)

Requirements: Node.js 22+, Docker (for PostgreSQL).

```bash
cd servia-agent
npm install
cp .env.example .env                 # defaults use AI_PROVIDER=offline: no API keys needed
docker compose up -d db              # PostgreSQL 16 on localhost:5432 (also creates servia_test)
npm run db:migrate                   # apply migrations
npm run knowledge:reload             # load ./knowledge into the database
npm run simulate -- "What does SERVIA do?"
npm run simulate -- --channel instagram "بكام الخدمة؟"
npm run simulate -- --channel messenger   # interactive; type /exit to quit
npm test                             # 128 tests: unit + integration against PostgreSQL
npm run dev                          # start the server on :3000 (GET /health, GET /ready)
```

`AI_PROVIDER=offline` is a deterministic, credential-free stand-in that answers with the best-matching
knowledge passage. It lets you test retrieval, storage, handoff and the HTTP flow without an OpenAI key.
To use the real model, set `AI_PROVIDER=openai`, `OPENAI_API_KEY` and `AI_MODEL` in `.env`.

The npm scripts load `.env` automatically when it exists (Node's `--env-file-if-exists`). In containers and on hosting
platforms, set real environment variables instead; they take precedence.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start the server with reload (tsx) |
| `npm run build` then `npm start` | Production build and start (`node dist/src/main.js`) |
| `npm run worker` | Run only the job worker (if you split web and worker processes) |
| `npm run db:migrate` | Apply database migrations |
| `npm run db:generate` | Generate a new migration after editing `src/database/schema.ts` |
| `npm run knowledge:reload` | Sync `knowledge/` into the database |
| `npm run simulate -- [--channel c] [--sender id] "message"` | Run the full pipeline without sending anything |
| `npm run eval [-- --verbose]` | Run the evaluation dataset (`eval/dataset.json`) against the configured provider |
| `npm run data:purge [-- --days N \| --contact <uuid>]` | Retention purge, or delete one contact's data |
| `npm test` | All tests (needs PostgreSQL: `docker compose up -d db`) |
| `npm run typecheck` | TypeScript strict check |

## Editing the knowledge base

The assistant only knows what is in [`knowledge/`](knowledge/README.md).
- Edit the Markdown files, or drop in text-based PDFs.
- Run `npm run knowledge:reload`, or restart the server, which reloads on start.
- No code change is needed.

Sections marked **UNCONFIRMED** are things the build could not verify, because getservia.tech was not
reachable from the build environment. Replace each `> OWNER TODO` with real facts. Write facts in English
and Arabic so both kinds of questions find them.

## HTTP API

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness |
| `GET /ready` | none | Database reachable and knowledge loaded (503 otherwise) |
| `GET /webhooks/{whatsapp,instagram,messenger}` | verify token | Meta subscription handshake |
| `POST /webhooks/{whatsapp,instagram,messenger}` | `X-Hub-Signature-256` | Meta events. Only enabled channels have routes |
| `POST /simulate` `{channel, senderId, message}` | admin | Proposed reply; nothing is sent. Needs `SIMULATOR_ENABLED=true` |
| `GET /admin/conversations?status=handoff` | admin | Conversations waiting for a human |
| `GET /admin/conversations/:id/messages` | admin | Transcript, with knowledge source IDs per reply |
| `POST /admin/conversations/:id/status` `{status: open\|handoff\|closed}` | admin | Reopen a handed-off conversation |
| `DELETE /admin/contacts/:id` | admin | Delete a contact and all their messages |
| `POST /admin/retention/purge` `{days?}` | admin | Delete conversations idle longer than N days |
| `POST /admin/knowledge/reload` | admin | Reload the knowledge base |
| `GET /admin/stats` | admin | Pending/failed jobs, handoffs, failed replies, token usage (24h) |

The admin API exists only when `ADMIN_API_TOKEN` is set (at least 32 characters), and every call needs
`Authorization: Bearer <token>`.

## Architecture

```
src/
  config/          zod-validated environment (the only reader of process.env)
  observability/   pino logger with secret redaction
  database/        Drizzle schema, pg pool, migrations (drizzle/)
  knowledge/       Markdown/PDF loader, chunker, Arabic/English normalization, full-text search, reload
  ai/              system prompt, OpenAI + offline providers, output guards, Agent
  conversations/   ingest/dedupe, history, handoff, retention, simulator
  messaging/       job queue (FOR UPDATE SKIP LOCKED), processor (one reply per inbound), worker
  channels/        whatsapp/, instagram/, messenger/ adapters + shared Meta helpers
  webhooks/        webhook routes
  http/            Fastify app, admin API
  eval/            evaluation runner
  cli/             migrate, reload-knowledge, simulate, worker, eval, purge
```

The design, decisions and data model are in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).
Current state and blockers are in [PROJECT_STATUS.md](PROJECT_STATUS.md).

## More documentation

- [docs/CHANNEL_SETUP.md](docs/CHANNEL_SETUP.md): Meta app, permissions, webhooks and verification for each channel
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): deploying, HTTPS, environment, rollback and recovery
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md): common problems and fixes
- [docs/DATA_AND_SECURITY.md](docs/DATA_AND_SECURITY.md): what is stored, retention, deletion, security controls
