/**
 * Alchemy composition root (Infrastructure-as-Effects) for the Beam
 * Cloudflare subproject. Replaces the old `wrangler.toml` /
 * `wrangler.telegram.toml` deployment pipeline: one typed program declares
 * both Workers plus the D1 / KV / R2 / Vectorize resources they bind.
 *
 * Docs (ground truth, v2 Effect line, npm `alchemy@2.0.0-beta.76`):
 *  - Workers (async env prop): https://alchemy.run/cloudflare/compute/workers
 *  - D1:        https://alchemy.run/cloudflare/data/d1
 *  - KV:        https://alchemy.run/cloudflare/data/kv
 *  - R2:        https://alchemy.run/cloudflare/data/r2
 *  - Vectorize: https://alchemy.run/cloudflare/ai/vectorize
 *  - Secrets & env: https://alchemy.run/cloudflare/security/secrets-env
 *
 * ADOPTION: every resource below carries an EXPLICIT physical name/title
 * matching the resources already live in the Cloudflare account. On a first
 * deploy with empty state, each provider's `read` finds the live resource by
 * name and adopts it — no `--adopt` flag and no destructive create. Explicit
 * `name`/`title` also bypasses alchemy's `${app}-${stage}-${id}` physical-name
 * generator, so the `prod` stage never renames anything; the stage only scopes
 * the alchemy state keyspace. Renaming any of these would break adoption and,
 * for the immutable resources, trigger a destructive replace.
 *
 * SINGLE STAGE: this project deploys one production stack (`--stage prod`).
 * There are deliberately no per-PR preview stages — the shared production D1
 * must never be destroyed by a PR closing.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

// ---------------------------------------------------------------------------
// Data resources (shared physical identity — exact live names)
// ---------------------------------------------------------------------------

/**
 * D1: `beam-db`. Shared by BOTH workers via the `DB` binding.
 *
 * GUARDRAIL — do not change `name` / `jurisdiction` / `primaryLocationHint`
 * (or the account): each is creation-immutable, and editing it makes the
 * provider plan a destructive REPLACE (drop + recreate the production DB).
 * The wrangler-applied migrations are recognized through the wrangler-compatible
 * `d1_migrations` tracking table and skipped on adopt; new files apply on deploy.
 */
export const database = Cloudflare.D1.Database("database", {
  name: "beam-db",
  migrations: { dir: "../migrations", table: "d1_migrations" },
});

/** KV: `beam-cache` (title is the adopted identity). Shared via the `CACHE` binding. */
export const cache = Cloudflare.KV.Namespace("cache", {
  title: "beam-cache",
});

/**
 * R2: `beam-backups`, exposed as the `BACKUPS` binding.
 *
 * NOTE: release/canary CI writes release bundles to this bucket OUT-OF-BAND
 * (`npx wrangler r2 object put` in release.yml / ci.yml). It is declared here
 * only so the binding exists — never run `alchemy destroy` / a replace against it.
 */
export const backups = Cloudflare.R2.Bucket("backups", {
  name: "beam-backups",
});

export const telemetryArchive = Cloudflare.R2.Bucket("telemetryArchive", {
  name: "beam-telemetry",
});

/**
 * Vectorize: `beam-memory`. Bound as `MEMORY` for embeddings.
 *
 * `dimensions` and `metric` MUST match the live index: a Vectorize index is
 * immutable, and an adoption diff with either omitted would plan a REPLACE
 * (delete + recreate an EMPTY index, losing every embedding).
 */
export const memory = Cloudflare.Vectorize.Index("memory", {
  name: "beam-memory",
  dimensions: 384,
  metric: "cosine",
});

// ---------------------------------------------------------------------------
// Workers — plain Hono modules, bound as async Workers. Secrets are
// `Config.redacted("<NAME>")` values: resolved from CI env vars at deploy
// time and uploaded as Cloudflare `secret_text`.
//
// BUNDLING: `main` points at PREBUILT single-file ESM bundles
// (`bun run build:workers` at the workspace root, chained by `deploy`) and
// `bundle: false` makes Alchemy upload them byte-for-byte (Wrangler's
// `no_bundle` contract — no rolldown, no minification, no transformation).
// Deliberate: alchemy@2.0.0-beta.64's rolldown pipeline stripped the Hono
// route registrations from our entries in production deploys — uploads
// "succeeded" but workers answered 404 for every path. esbuild reproduces
// the wrangler-era bundling that ran production for months.
// ---------------------------------------------------------------------------

const compatibility = {
  date: "2026-07-11",
  flags: ["nodejs_compat"],
};

// Mirrors wrangler.toml [observability]: master off, logs on (persisted,
// invocation logs), traces off. Field names are the Cloudflare API camelCase.
const observability = {
  enabled: false,
  headSamplingRate: 1,
  logs: {
    enabled: true,
    headSamplingRate: 1,
    persist: true,
    invocationLogs: true,
  },
  traces: {
    enabled: false,
    headSamplingRate: 1,
    persist: true,
  },
};

/** API worker — `beam-api.pryx.dev` (custom domain, consistent with the bot's
 * `beam.pryx.dev`; workers.dev hostname remains reachable as a fallback). */
export const api = Cloudflare.Worker("api", {
  name: "beam-api",
  main: "../dist/api/index.mjs",
  bundle: false,
  compatibility,
  observability,
  domain: { name: "beam-api.pryx.dev" },
  env: {
    // Native Cloudflare bindings (same binding names as wrangler.toml).
    DB: database,
    CACHE: cache,
    BACKUPS: backups,
    TELEMETRY_ARCHIVE: telemetryArchive,
    MEMORY: memory,
    // Plain vars (literal string -> `plain_text`).
    ENVIRONMENT: "production",
    TELEGRAM_WEBHOOK_URL: "https://beam.pryx.dev/webhook",
    TELEGRAM_BOT_URL: "https://beam.pryx.dev",
    // Secrets (Config.redacted -> `secret_text`, read from CI env at deploy).
    TELEGRAM_BOT_TOKEN: Config.redacted("TELEGRAM_BOT_TOKEN"),
    BOT_API_SECRET: Config.redacted("BOT_API_SECRET"),
    ADMIN_API_KEY: Config.redacted("ADMIN_API_KEY"),
    FEE_WALLET_ADDRESS: Config.redacted("FEE_WALLET_ADDRESS"),
  },
});

/** Telegram bot worker — `beam.pryx.dev` (custom domain: Telegram's resolver
 * consistently fails on the workers.dev hostname, error "bad webhook: Failed
 * to resolve host"; the account's own zones resolve fine). Renamed from
 * `bot.pryx.dev` on 2026-08-11 (bot -> beam branding). */
export const telegramBot = Cloudflare.Worker("telegramBot", {
  name: "beam-telegram-bot",
  main: "../dist/telegram-bot/index.mjs",
  bundle: false,
  compatibility,
  observability,
  // Custom domain with automatic DNS + edge cert (zone pryx.dev exists in
  // this account). workers.dev hostname remains reachable as a fallback.
  domain: { name: "beam.pryx.dev" },
  env: {
    // Shares the SAME database and KV namespace as the API worker.
    DB: database,
    CACHE: cache,
    // Plain var: the custom-domain HTTPS URL the bot calls (NOT a service binding).
    API_BASE_URL: "https://beam-api.pryx.dev",
    // Service binding to the API worker. Cloudflare rejects worker->worker
    // fetches over the same-zone workers.dev hostname (error 1042); the
    // binding is the sanctioned transport. `api` is declared above, so no TDZ.
    API_SERVICE: api,
    // Secrets.
    TELEGRAM_BOT_TOKEN: Config.redacted("TELEGRAM_BOT_TOKEN"),
    TELEGRAM_WEBHOOK_SECRET: Config.redacted("TELEGRAM_WEBHOOK_SECRET"),
    BOT_API_SECRET: Config.redacted("BOT_API_SECRET"),
  },
});

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

export default Alchemy.Stack(
  "beam",
  {
    providers: Cloudflare.providers(),
    // Remote state store (worker + Durable Object, account-level Secrets
    // Store). REQUIRED for CI runners (no local disk state). One-time
    // bootstrap: `bun alchemy cloudflare bootstrap` (or the interactive
    // prompt on first `alchemy deploy`). In CI, `CI=true` (auto in GitHub
    // Actions) resolves the store credentials from the Secrets Store.
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // Deploy data resources FIRST so the D1 migration tracking / adoption
    // resolves (and pending migrations apply) before the Workers that bind
    // them — reproducing wrangler's migrations-then-deploy ordering.
    const db = yield* database;
    yield* cache;
    yield* backups;
    yield* telemetryArchive;
    yield* memory;

    const apiWorker = yield* api;
    const botWorker = yield* telegramBot;

    return {
      databaseName: db.databaseName,
      apiWorkerUrl: apiWorker.url,
      botWorkerUrl: botWorker.url,
    };
  }),
);
