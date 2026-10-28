# Data handling and security

## What is stored (PostgreSQL)

| Data | Why | Notes |
|---|---|---|
| Contact: channel, platform user ID (WhatsApp number / page-scoped ID / Instagram-scoped ID), display name if the platform sends one | To keep a conversation together | No other profile data is fetched |
| Messages: text, direction, timestamps, platform message IDs | Conversation history and audit | Non-text content (images, audio) is **not** downloaded; only its type is stored |
| Per reply: knowledge passage IDs used, model name, token counts, outcome and error codes | Audit, cost tracking, debugging | |
| Webhook event keys | Deduplication and audit | Not the payload |
| Jobs | Reliable delivery | Payload is only the message ID |

Not stored: access tokens and API keys (environment only), raw webhook payloads, request headers.

Customers may write personal or medical details into free text. That text is stored as part of the conversation,
so keep retention short and delete on request.

## Retention and deletion

- **Retention:** conversations idle longer than `RETENTION_DAYS` (default 180) are deleted with all their messages
  by `npm run data:purge` or `POST /admin/retention/purge`. Run it daily (see DEPLOYMENT.md). It also removes
  orphaned contacts, old webhook event keys, and finished jobs.
- **Deletion request:** find the contact ID in `GET /admin/conversations` or the transcript, then call
  `DELETE /admin/contacts/<id>` or `npm run data:purge -- --contact <id>`. This deletes the contact and,
  by cascade, all their conversations and messages.
- **Backups** contain the same data. Expire them on the same schedule.
- **OpenAI:** requests are sent with `store: false`. OpenAI's own data policies still apply to API traffic;
  review them for your account.

## Security controls

| Control | Where |
|---|---|
| Secrets only from environment; `.env` git-ignored; `.env.example` holds placeholders only | `src/config/env.ts`, `.gitignore` |
| Configuration validated at start-up; offline provider refused in production | `src/config/env.ts` |
| Webhook signature (HMAC-SHA256 of the raw body, constant-time compare) | `src/channels/meta.ts` |
| Verify-token handshake, constant-time compare | `src/channels/meta.ts` |
| Input validation with zod for webhooks and admin input | adapters, `src/http/admin.ts` |
| Request body size limit; per-IP rate limiting | `src/http/app.ts` |
| Parameterized SQL only (Drizzle and bound parameters; tsquery built from letter/digit tokens) | `src/knowledge/repository.ts` |
| Admin API disabled unless `ADMIN_API_TOKEN` (≥ 32 chars) is set; bearer check in constant time | `src/http/admin.ts` |
| Simulator requires the admin token and `SIMULATOR_ENABLED` | `src/http/admin.ts` |
| Safe error responses (no stack traces); request IDs | `src/http/app.ts` |
| Log redaction of auth headers, signatures, tokens; query strings never logged; message text never logged | `src/observability/logger.ts`, `src/http/app.ts` |
| Graph API tokens sent in the `Authorization` header, not the URL | `src/channels/meta.ts` |
| Non-root container user | `Dockerfile` |
| HTTPS terminated by Caddy (VPS) or the platform | `deploy/` |
| No CORS: there is no browser UI. If one is added, allow only its origin | — |

## AI safety controls

- Customer messages and knowledge passages go to the model as data, in separate roles and delimiters. The system
  prompt tells the model to ignore instructions found inside them.
- No tools are enabled: the model cannot browse, run code, send email, or take actions. Customer text never
  triggers actions, apart from a deterministic handoff when a person is requested.
- Output guards:
  - replies stating currency amounts that do not appear in the retrieved knowledge are replaced;
  - replies containing the system prompt (canary or verbatim text) are replaced;
  - source IDs are restricted to retrieved passages.
- The assistant identifies as an AI and never promises a response time unless `HUMAN_FOLLOWUP_TIMEFRAME` is set.
