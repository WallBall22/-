# SERVIA AI Customer Service Agent — Implementation Plan

Status: active. This plan replaces the earlier JavaScript prototype (`docs/superpowers/specs/2026-10-28-servia-knowledge-rag-design.md` and its plan). The prototype code was removed from the repository root; it remains in git history.

## 1. Inspection results (2026-10-28)

| Item | Finding | Consequence |
|---|---|---|
| Runtime | Node.js 22.22, npm 10.9 | Target Node 22 LTS. |
| Existing project | Repository root holds a legacy Discord bot (`bot.js`, `Procfile`, root `package.json`). | Preserved untouched. The new app lives in `servia-agent/` so nothing collides. |
| PostgreSQL | PostgreSQL 16 server available locally. | Integration tests run against real Postgres, not mocks. |
| Docker | Docker Engine 29 available. | `docker-compose.yml` and the `Dockerfile` can be verified locally. |
| getservia.tech | Blocked by this environment's network policy. | Knowledge files contain only owner-provided facts from the brief. Everything else is marked **UNCONFIRMED**. |
| Meta developer docs | Direct fetch blocked; reachable only through web-search summaries. | Adapters follow the documented Graph API shapes. The Graph API version is configurable. Every adapter is marked "not verified end-to-end" until tested with real credentials. |
| OpenAI API | No API key in this environment. | Tests use an injected fake client. An `offline` provider lets the simulator run without credentials. |

## 2. Architecture

One Node.js process (Fastify) serves webhooks and the admin and simulator endpoints. It also runs a PostgreSQL-backed job worker. The worker can be split into its own process later (`npm run worker`) without code changes.

```
Meta webhook ──► /webhooks/<channel> ──► signature check (raw body)
                                      ──► adapter.parse → NormalizedInbound[]
                                      ──► conversations.ingest (tx: contact, conversation,
                                          message [unique platform id], job)
                                      ◄── 200 OK immediately

worker loop ──► claim job (FOR UPDATE SKIP LOCKED)
            ──► per-conversation advisory lock
            ──► agent.reply(history, inbound)
                   ├─ knowledge.search (Postgres FTS, threshold)
                   ├─ ai provider (OpenAI Responses API | offline)
                   └─ output guards (source ids, prices, prompt leak, length)
            ──► insert outbound message (unique reply_to → one reply per inbound)
            ──► adapter.send (same channel) → delivery status
```

### Modules (`servia-agent/src/`)

| Module | Responsibility |
|---|---|
| `config` | Zod-validated environment. The only place env vars are read. |
| `observability` | Pino logger with secret redaction, correlation IDs, and error serialization. |
| `database` | Drizzle schema, pg pool, migrations runner, transaction helper. |
| `knowledge` | Markdown/PDF loader, chunker, Arabic and English normalization, FTS search, reload. |
| `ai` | System prompt, provider interface, OpenAI provider, offline provider, output guards, the agent. |
| `conversations` | Ingest, history, handoff state, retention and deletion, per-contact limits. |
| `messaging` | Job queue (outbox), worker, retry and backoff policy, sender registry. |
| `channels/whatsapp`, `channels/instagram`, `channels/messenger` | Webhook verification, signature check, payload normalization, send API, and error classification, each kept inside its own adapter. |
| `webhooks` | Fastify routes that tie adapters to the conversation service. |
| `http` (server) | App factory, raw-body JSON parser, rate limit, health and readiness, admin auth, simulator. |

All external clients (OpenAI, Meta HTTP, clock, logger) are injected, so the services are testable without credentials.

## 3. Key decisions

1. **Location:** `servia-agent/`. This preserves the legacy bot at the repository root.
2. **ESM + TypeScript strict**, built with `tsc`. `tsx` is used for development scripts.
3. **Retrieval:** PostgreSQL full-text search with the `simple` configuration over app-normalized text. Normalization removes Arabic diacritics and tatweel, unifies alef, ya and ta marbuta, lowercases text, and strips common Arabic prefixes. Queries are OR-ed terms with prefix matching, ranked by `ts_rank_cd`, and filtered by `RETRIEVAL_MIN_RANK`. No embeddings.
4. **Grounding:** the model returns structured JSON `{ reply, needs_human, source_ids }` through the Responses API's JSON-schema output. Guards then run:
   - Unknown source IDs are dropped.
   - A reply that states a price or currency amount absent from the retrieved passages is replaced by the safe fallback.
   - A reply containing the internal canary string (prompt leak) is replaced.
   - Replies are truncated to the channel limit.
5. **No retrieval hits:** the model is still called, so greetings and clarifying questions work. It is told that no verified knowledge matched, and it must not state business facts and should offer human follow-up.
6. **Duplicate protection:**
   - Inbound messages are unique on `(channel, platform_message_id)`.
   - Outbound messages are unique on `reply_to_message_id`.
   - Webhook events are unique on `(channel, event_key)`.
7. **Concurrency:** a session-level `pg_try_advisory_lock` per conversation. A job that cannot take the lock is rescheduled a few seconds later.
8. **Retries:**
   - OpenAI: SDK-bounded retries with exponential backoff and a request timeout.
   - Send: transient errors (429, 5xx, network) retry with exponential backoff up to `JOB_MAX_ATTEMPTS`. Permanent errors (other 4xx) fail at once.
   - A retry resends the already-generated outbound text. It never generates a second reply.
9. **Handoff:** when the model sets `needs_human`, or the customer asks for a person, the conversation becomes `handoff`. The bot stays silent in that conversation until an admin resumes it. No human response time is promised unless `HUMAN_FOLLOWUP_TIMEFRAME` is set.
10. **Offline provider** (`AI_PROVIDER=offline`): a deterministic extractive responder (top passage, or fallback). It exists so the simulator and evaluation can run without an OpenAI key. It is not for production.
11. **PDF knowledge:** `.pdf` files in the knowledge directory are ingested alongside Markdown, as the owner originally asked for PDF-based RAG.

## 4. Data model

`channels`, `contacts`, `conversations`, `messages`, `webhook_events`, `jobs`, `knowledge_documents`, `knowledge_chunks`, `agent_settings`. See `src/database/schema.ts`.

## 5. Milestones (each ends with passing tests and a commit)

1. Scaffold: package, tsconfig, vitest, config, logger.
2. Database: schema, migrations, compose file, migrate script, test DB harness.
3. Knowledge: seed files, loader, chunker, normalization, FTS search, reload CLI.
4. AI: prompt, providers, guards, agent.
5. Conversations and messaging: ingest, jobs, worker, lock, retries, handoff, limits.
6. Channels and HTTP: three adapters, webhook routes, admin, simulator endpoint and CLI, health.
7. Evaluation dataset and runner, Dockerfile, documentation, final verification.

## 6. Dependencies

Runtime:
- `fastify`
- `@fastify/rate-limit`
- `drizzle-orm`
- `pg`
- `openai`
- `zod`
- `pino`
- `pdf-parse`

Development:
- `typescript`
- `tsx`
- `vitest`
- `drizzle-kit`
- `@types/node`
- `@types/pg`

## 7. Environment variables

The full list with descriptions is in `.env.example`. Required in production:
- `DATABASE_URL`
- `OPENAI_API_KEY` (when `AI_PROVIDER=openai`)
- `AI_MODEL`
- `ADMIN_API_TOKEN`
- Per enabled channel:
  - WhatsApp: `META_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`
  - Messenger: `MESSENGER_VERIFY_TOKEN`, `MESSENGER_PAGE_ACCESS_TOKEN`
  - Instagram: `INSTAGRAM_APP_SECRET`, `INSTAGRAM_VERIFY_TOKEN`, `INSTAGRAM_ACCESS_TOKEN`

## 8. Acceptance criteria

These match the brief's Definition of Done:
1. The server starts locally.
2. Migrations apply to a clean database.
3. Answers come from the knowledge base.
4. Unknown facts are not fabricated.
5. History is persisted.
6. Duplicate webhooks do not produce duplicate replies.
7. All tests pass.
8. The simulator works without credentials.
9. Channel setup is documented.
10. No channel is claimed as live without an end-to-end test.
11. No secrets are committed.
12. The README reproduces the setup.

## 9. Known blockers

- Real SERVIA facts beyond the brief: pricing, implementation timeline, contact channels, FAQ answers. The owner must fill the UNCONFIRMED sections in `knowledge/`.
- Meta app, Business verification, permissions and app review, and access tokens for each channel.
- OpenAI API key.
- A hosting account, for deployment approval.
