# Troubleshooting

Logs are JSON lines, one per event, and each request has a `reqId`. The `x-request-id` response header carries
the same value. Message text and tokens are never logged.

## Start-up

| Symptom | Cause | Fix |
|---|---|---|
| `ConfigError: Invalid configuration` listing variables | Missing or invalid environment | Fix each listed variable; see `.env.example` |
| `AI_PROVIDER=offline ... not allowed in production` | Offline provider with `NODE_ENV=production` | Set `AI_PROVIDER=openai` with `OPENAI_API_KEY` and `AI_MODEL` |
| `Could not find the drizzle migrations folder` | Running from an unexpected directory | Run from `servia-agent/`, or set `MIGRATIONS_DIR` |
| `/ready` returns 503 with `knowledgePassages: 0` | Knowledge never loaded | `npm run knowledge:reload`; check the `knowledge reload at startup failed` log |
| Tests fail with `Cannot reach the test database` | PostgreSQL not running | `docker compose up -d db` (creates `servia_test`), or set `TEST_DATABASE_URL` |

## Webhooks

| Symptom | Cause | Fix |
|---|---|---|
| Meta "Verify and save" fails / log `webhook verification rejected` | Verify token mismatch, or the channel is not enabled (404) | Same token in `.env` and in Meta; `*_ENABLED=true`; restart |
| Log `webhook signature rejected` (401) | Wrong secret, or a proxy changed the body | WhatsApp/Messenger use `META_APP_SECRET`; Instagram uses `INSTAGRAM_APP_SECRET`. Do not let a proxy re-encode JSON |
| `413` responses | Payload above `REQUEST_BODY_LIMIT_BYTES` | Raise the limit slightly (default 1 MB is above Meta's normal sizes) |
| `429` responses to Meta | Rate limit too low for your traffic | Raise `RATE_LIMIT_MAX` |
| Webhooks arrive but `messages: 0` | Event types other than messages (status, account updates), or WhatsApp events for another phone number ID | Expected; check `ignored` in the `webhook processed` log and `WHATSAPP_PHONE_NUMBER_ID` |

## No reply was sent

Check the conversation with `GET /admin/conversations/<id>/messages`. The inbound message's `processingStatus`
and `errorCode` tell you why:

| `processingStatus` / `errorCode` | Meaning | Action |
|---|---|---|
| `queued` (stays) | Worker not running | `WORKER_ENABLED=true`, or run `npm run worker` |
| `skipped` / `handoff` | Conversation is waiting for a human | Reply from the Meta inbox. Reopen with `POST /admin/conversations/<id>/status {"status":"open"}` |
| `skipped` / `superseded` | A newer message from the same person was answered instead | Expected |
| `skipped` / `rate_limited` | Contact exceeded `MAX_MESSAGES_PER_CONTACT_PER_HOUR` | Expected; raise the limit if needed |
| `failed` / `channel_disabled` | Channel adapter not enabled | Enable the channel |
| `failed` / `http_...` | Meta rejected the send; see the outbound message's `errorDetail` | See below |

## Meta send errors (`errorCode` on the outbound message)

| Code | Usual meaning | Retried? | Fix |
|---|---|---|---|
| `http_401_190` | Access token invalid or expired (Instagram tokens expire after about 60 days) | No | Generate or refresh the token; update `.env`; restart |
| `http_403_10` / `http_400_10` | Permission missing or not approved | No | Check permissions and App Review status |
| `http_400_100` | Invalid parameter (often a wrong phone number ID or recipient) | No | Check IDs |
| `http_400_131047` | WhatsApp: more than 24 hours since the customer's last message | No | A human must use an approved template |
| `http_400_4`, `_17`, `_32`, `_613`, `_80007`, `_130429`, `_131056` | Rate limits | Yes, with backoff | Usually resolves; reduce volume if persistent |
| `http_5xx`, `network`, `timeout` | Platform or network problem | Yes, with backoff | Usually resolves |
| `send_retries_exhausted` | All `JOB_MAX_ATTEMPTS` retries failed | – | Check Meta status; the customer did not get the reply |

## Model (OpenAI)

The outbound message's `aiOutcome` and `aiErrorCode` explain fallbacks:

| `aiErrorCode` | Meaning | Fix |
|---|---|---|
| `auth` | Invalid `OPENAI_API_KEY` | Fix the key |
| `rate_limited` | Rate limit or quota exhausted | Check billing and usage limits |
| `timeout` / `unavailable` | Slow or unavailable API | Usually transient; raise `AI_TIMEOUT_MS` if persistent |
| `invalid_request` | Model does not support a parameter (for example structured outputs) | Choose a model that supports JSON-schema structured output in the Responses API |
| `incomplete` | Output cut off at `AI_MAX_OUTPUT_TOKENS` | Raise it, especially for reasoning models |
| `unsupported_price` | The model stated a price not in the knowledge base | Working as intended. Add real prices to the knowledge base if you want them quoted |
| `prompt_leak` | The model tried to reveal its instructions | Working as intended |
| `malformed_output` / `empty_reply` | Invalid structured output | Try another model; report if frequent |

## Answers are wrong or missing

- Run `npm run simulate -- "<the question>"` and look at `sources`.
  - Wrong or no sources means a retrieval problem: add words customers actually use to the right section,
    in both languages, or as a `Keywords:` line.
  - Correct sources but a bad answer means the facts in that passage need to be clearer.
- Run `npm run eval -- --verbose` after knowledge changes. Add a case to `eval/dataset.json` for each real
  mistake you fix.
- Arabic spelling variants (أ/إ/ا, ة/ه, ى/ي, diacritics) are normalized automatically. Synonyms are not, so add them as keywords.
