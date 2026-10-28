# Deployment

The service is one Node.js process (web server and job worker) plus PostgreSQL. It needs:

- a host that keeps a Node.js process or container running,
- HTTPS on a public domain (Meta requires it for webhooks),
- a PostgreSQL 14+ database (16 is tested).

Nothing depends on your own computer once it is deployed.

> Nothing has been deployed. Creating paid resources, DNS records or production Meta settings needs the owner's approval.

## Cheapest practical path: one small VPS with Docker

A small Linux VPS (1 vCPU, 1–2 GB RAM is enough for an MVP) runs everything from
`deploy/docker-compose.prod.yml`: app, PostgreSQL, and Caddy for automatic Let's Encrypt HTTPS.
Small VPS plans usually cost a few US dollars a month; check your provider's current pricing.

1. Create the VPS (Ubuntu 24.04 LTS) and install Docker Engine with the compose plugin.
2. Point a DNS **A record** for your subdomain (for example `agent.getservia.tech`) at the VPS IP.
3. Open ports 80 and 443 only, for example with `ufw allow 80,443/tcp` and `ufw allow OpenSSH`.
4. On the server:
   ```bash
   git clone <this repo> && cd <repo>/servia-agent
   cp .env.example .env
   # Edit .env:
   #   NODE_ENV=production
   #   AI_PROVIDER=openai, AI_MODEL=..., OPENAI_API_KEY=...
   #   ADMIN_API_TOKEN=$(openssl rand -hex 32)
   #   channel variables for the channels you enable (see CHANNEL_SETUP.md)
   #   HUMAN_FOLLOWUP_TIMEFRAME only if the team commits to one
   export DOMAIN=agent.getservia.tech POSTGRES_PASSWORD=$(openssl rand -hex 24)
   # Store POSTGRES_PASSWORD somewhere safe: the database volume is created with it.
   docker compose -f deploy/docker-compose.prod.yml up -d --build
   curl https://$DOMAIN/ready
   ```
   Migrations and the knowledge reload run automatically at start-up
   (`RUN_MIGRATIONS_ON_START`, `KNOWLEDGE_RELOAD_ON_START`).
5. Register webhooks per [CHANNEL_SETUP.md](CHANNEL_SETUP.md) and run its end-to-end checklist.
6. Schedule backups and retention, for example with `crontab -e`:
   ```cron
   15 3 * * * cd /path/servia-agent && docker compose -f deploy/docker-compose.prod.yml exec -T db pg_dump -U servia servia | gzip > /backups/servia-$(date +\%F).sql.gz
   30 3 * * * cd /path/servia-agent && docker compose -f deploy/docker-compose.prod.yml exec -T app node dist/src/cli/purge.js
   ```
   Copy backups off the server, for example to object storage, and test a restore once.

## Alternative: managed platform

Any platform that runs a Dockerfile as a long-lived web service with HTTPS works, for example Render, Railway or
Fly.io, together with a managed PostgreSQL.

- Build from `servia-agent/Dockerfile`, with `servia-agent/` as the build context.
- Health check path: `/health`. Readiness: `/ready`.
- Set the environment variables from `.env.example`. Use the platform's secret store, not files.
- Keep **one instance** to start. The job queue is safe with several instances (claims use `SKIP LOCKED`, plus a
  per-conversation lock). The in-memory HTTP rate limiter, however, is per instance.
- Optional: run the worker separately with `node dist/src/cli/worker.js` and set `WORKER_ENABLED=false` on the web service.

## Environment variables

All variables, with defaults and descriptions, are in [`.env.example`](../.env.example). Validation runs at start-up,
and the process refuses to start with a clear message listing every problem. For example:

- `AI_PROVIDER=offline` in production,
- an enabled channel with missing secrets,
- an admin token shorter than 32 characters.

## Releasing a new version

1. `npm ci && npm run typecheck && npm test` (locally or in CI).
2. **Back up the database** (`pg_dump`) before any release that adds a migration (new file in `drizzle/`).
3. Build and tag the image with the git commit, for example `docker build -t servia-agent:$(git rev-parse --short HEAD) .`.
   On the VPS, `git pull` then `docker compose -f deploy/docker-compose.prod.yml up -d --build`.
4. Watch `/ready` and the logs for a few minutes. Send a test message.

## Rollback and recovery

- **Code rollback:** redeploy the previous image or commit. Migrations are forward-only and additive. The previous
  code version still runs against a schema that only gained columns, as is true of every migration in this repo
  so far. If a future migration removes or renames something, the release notes must say rollback requires a
  database restore.
- **Database restore:** stop the app, then restore the last dump:
  `gunzip -c servia-YYYY-MM-DD.sql.gz | docker compose -f deploy/docker-compose.prod.yml exec -T db psql -U servia servia`
  Start the app again.
- **Crashed worker:** jobs left `running` for more than 5 minutes return to the queue automatically. Replies already
  stored are resent, never regenerated.
- **Failed replies:** `GET /admin/stats` shows `replies_failed_24h` and `jobs_failed`. The causes are in each outbound
  message's `errorCode` and `errorDetail` (see the admin transcript).
- **Model outage:** customers get a safe fallback and the conversation is handed off. Nothing is lost; the team
  can follow up from `GET /admin/conversations?status=handoff`.
- **Bad knowledge edit:** revert the file and run `POST /admin/knowledge/reload` or restart. Reload refuses to
  wipe the knowledge base if the folder is empty.
- **Emergency stop:** set `*_ENABLED=false` for a channel and restart. Its webhook route disappears, and Meta's
  deliveries fail and are retried by Meta later.
