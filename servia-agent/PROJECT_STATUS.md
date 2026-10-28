# SERVIA Agent — Project Status

Last updated: 2026-10-28

## Summary

The MVP backend is implemented and tested locally. Nothing is deployed, and **no channel has been tested with real Meta
credentials**. The knowledge base contains only facts from the owner's brief, because getservia.tech could not be read
from the build environment.

## Milestones

| Milestone | Status | Evidence |
|---|---|---|
| 1. Scaffold (TS strict, config, logging) | done | `npm run typecheck` clean; config and logger tests |
| 2. Database (schema, 4 migrations, compose) | done | Migrations applied to a clean DB in every test run; applied incrementally on an existing DB; compose DB verified |
| 3. Knowledge (Markdown/PDF, FTS, reload) | done | Retrieval tests with Arabic and English questions over the shipped knowledge |
| 4. AI agent (prompt, OpenAI/offline providers, guards) | done | Fake-model tests: grounding, injection, prompt leak, invented price, timeouts/failures |
| 5. Conversations and messaging (dedupe, jobs, lock, retries, handoff) | done | Integration tests on PostgreSQL: duplicates, concurrency, retries, permanent failures, handoff, receipts, retention |
| 6. Channels and HTTP (3 adapters, webhooks, admin, simulator) | done (mocked) | Adapter tests with documented payload shapes; HTTP end-to-end tests with signed webhooks and a mocked Graph API |
| 7. Evaluation, Docker, docs | done | 18/18 eval cases (offline provider); image built and started; docs written |

## Test results (latest run)

- `npm test`: **128 passed, 0 failed** (10 files), on local PostgreSQL 16 and on the docker-compose PostgreSQL.
- `npm run eval` (offline provider): **18/18 passed**.
- `npm run typecheck`: clean. `npm run build`: clean.
- Docker image: built and started. It ran as the non-root `node` user, applied migrations, loaded 17 passages, and
  `/health` and `/ready` returned 200. The build needed this sandbox's proxy CA injected into a throwaway build
  context; the committed Dockerfile is unchanged and needs no proxy on a normal host.
- `npm audit --omit=dev`: 0 vulnerabilities. Dev-only: 4 moderate findings in `drizzle-kit`'s bundled esbuild
  (affects only a local dev server, which this project does not use).

## Channel status

| Channel | Implemented | Unit/integration tested (mocked) | Verified with real credentials |
|---|---|---|---|
| WhatsApp Cloud API | yes | yes | **no** |
| Facebook Messenger | yes | yes | **no** |
| Instagram (Instagram Login) | yes | yes | **no** |
| OpenAI Responses API | yes | yes (fake client) | **no** |

## Blockers and what the owner must provide

1. **Business facts:** pricing (or confirm it stays unpublished), implementation steps and timeline, contact email and
   phone, working hours, the channels and integrations the AI receptionist supports, and any client types or regions.
   Fill the `> OWNER TODO` lines in `knowledge/`.
2. **OpenAI:** an API key and the model ID to use (`AI_MODEL`). Then run `AI_PROVIDER=openai npm run eval`.
3. **Meta:** a Business portfolio and developer app; WhatsApp WABA, phone number and System User token; Facebook Page
   and Page token; Instagram professional account and token. Business verification and App Review are needed for
   public messaging.
4. **Hosting approval:** a VPS or managed platform, a domain or subdomain for HTTPS, and approval to create these
   paid resources.
5. **Network access (build environment only):** getservia.tech and developers.facebook.com were blocked here.
   Allow them if the next session should verify facts and API details directly.

## Known limitations

- Text only. Images, audio and stickers get a "please type your question" reply; media is not downloaded.
- Messenger postbacks are ignored. WhatsApp templates (needed for human replies after 24 hours) are not sent.
- Instagram tokens expire (about 60 days) and are not refreshed automatically.
- The HTTP rate limiter is in-memory, per instance.
- The offline provider is extractive. It shows raw passage text, including "UNCONFIRMED" wording, and is for local
  testing only.

## Next steps

1. The owner fills the knowledge gaps, then runs `npm run simulate` and `npm run eval`.
2. Deploy to a small VPS (docs/DEPLOYMENT.md). Verify one channel end to end (WhatsApp first), then the others.
3. Add eval cases from real conversations. Tune `RETRIEVAL_MIN_RANK` and keywords from observed misses.
