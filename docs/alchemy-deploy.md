# Alchemy (Cloudflare) Deployment Plan

Research report (2026-08-08). The wrangler→alchemy migration in `cloudflare/infra/`
is ~90% done and already deployed: D1 `beam-db`, R2 `beam-backups` +
`telemetryArchive`, Vectorize `beam-memory`, Workers `api` + `telegramBot`.

## Remaining work

1. **Agent cron worker** (the missing piece): `workers/agent/` with a
   workerd-safe entry that reuses the engine's 10-minute cycle logic against a
   `SqlClient`-style D1 interface; declare
   `Cloudflare.Worker("agent", { cron: "*/10 * * * *" })` via
   `Cloudflare.Workers.cron` + `CronEventSourceLive`, bound to `beam-db` (D1),
   `beam-memory` (Vectorize), `Config.redacted` secrets (EVM private key, RPC,
   LLM key). Optional `AgentLock` Durable Object for overlap protection.
2. **Effect version skew**: `cloudflare/infra/package.json` pins effect
   `-beta.102`; root is `-beta.105`. Align them.
3. **CI**: swap wrangler deploy for `bun alchemy deploy --stage prod --yes`
   (remote state); GitHub Action `alchemy-run/alchemy@v1` handles PR previews.
4. **sqlite-vec stays local-only** — the engine's vector memory cannot run on
   D1; vectors on the edge go through the already-provisioned Vectorize index.

## Notes

- `alchemy dev` runs workerd locally; D1/KV/R2/Queues emulated; cron not fired
  on a schedule in dev — trigger handlers manually or test deployed.
- Repo disabled alchemy bundling (`bundle: false` + esbuild prebuild) after
  rolldown stripped Hono routes — keep that arrangement.
- Costs: D1/Vectorize/cron/DO are paid-plan items; the free tier's 10 ms CPU
  makes the 10-min agent cycle non-viable.

## Key docs

<https://alchemy.run/llms.txt> · /cloudflare · /cloudflare/compute/workers ·
/cloudflare/messaging/cron · /cloudflare/data/d1 · /cloudflare/ai/vectorize ·
/cloudflare/security/secrets-env · examples/cloudflare-agent
