/* oxlint-disable */
import { Effect, Layer } from "effect";
import crypto from "node:crypto";
import { createLogger } from "./logger.js";
import type { AgentStateApi } from "./services.js";
import { AgentStateService, HttpStatusServerService } from "./services.js";
import type { AppConfig } from "./config-service.js";
import type { BeamStateSnapshot } from "./state-service.js";
import type { AgentProposal } from "./types.js";
import { parseHttpQueueProposal, ProposalParseError } from "./proposal-schema.js";
import { getCurrentVersion } from "./version.js";
import {
  buildOperatorStatus,
  positionStatusFromSnapshot,
  type OperatorStatus,
} from "./operator-status.js";

const logger = createLogger("HttpStatusServer");

/** Static, dependency-free dashboard. Read-only: it only GETs /status,
 *  /positions, /decisions and /config with a Bearer token the operator pastes
 *  in once. */
const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Beam — local status</title>
<style>
:root{color-scheme:dark}
body{margin:0;padding:24px;background:#0d1117;color:#c9d1d9;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
h1{font-size:16px;margin:0 0 4px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#8b949e;margin:24px 0 8px}
.muted{color:#8b949e}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.card{background:#161b22;border:1px solid #21262d;border-radius:6px;padding:10px}
.k{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.v{font-size:18px;margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #21262d;white-space:nowrap}
th{color:#8b949e;font-weight:500}tr:hover td{background:#161b22}
.pos{color:#3fb950}.neg{color:#f85149}
input,button{background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:6px 10px;font:inherit}
button{cursor:pointer}button:hover{border-color:#8b949e}
#gate{max-width:520px}#err{color:#f85149;min-height:18px}
</style></head><body>
<h1>Beam — local status</h1>
<div class="muted">loopback only · read-only · auto-refresh 10s · <span id="tick">idle</span></div>
<div id="gate" style="margin-top:24px">
  <p class="muted">Paste the agent read token (AGENT_PROPOSAL_TOKEN). It stays in this tab only.</p>
  <p><input id="token" type="password" size="40" placeholder="token" autocomplete="off"> <button id="go">Load</button></p>
  <p id="err"></p>
</div>
<div id="view" hidden>
  <h2>Portfolio</h2><div class="grid" id="portfolio"></div>
  <h2>Positions</h2><div id="positions"></div>
  <h2>Recent decisions</h2><div id="decisions"></div>
  <h2>Config</h2><div id="config"></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const usd = (n) => (typeof n === "number" && isFinite(n) ? "$" + n.toLocaleString(undefined, {maximumFractionDigits: 2}) : "—");
const num = (n) => (typeof n === "number" && isFinite(n) ? n.toFixed(2) : "—");
const ago = (ts) => {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return s + "s ago";
  if (s < 5400) return Math.round(s / 60) + "m ago";
  return Math.round(s / 3600) + "h ago";
};
let token = sessionStorage.getItem("beamToken") || "";
async function api(path) {
  const res = await fetch(path, { headers: { authorization: "Bearer " + token } });
  if (res.status === 401) throw new Error("401 — token rejected (AGENT_PROPOSAL_TOKEN must be set on the agent)");
  if (!res.ok) throw new Error(res.status + " " + res.statusText);
  return res.json();
}
function table(rows, cols) {
  if (!rows || rows.length === 0) return "<p class=muted>none</p>";
  return "<table><tr>" + cols.map((c) => "<th>" + esc(c.label) + "</th>").join("") + "</tr>" +
    rows.map((r) => "<tr>" + cols.map((c) => "<td>" + c.render(r) + "</td>").join("") + "</tr>").join("") + "</table>";
}
async function refresh() {
  try {
    const [status, positions, decisions, config] = await Promise.all([
      api("/status"), api("/positions"), api("/decisions?limit=25"), api("/config"),
    ]);
    $("gate").hidden = true; $("view").hidden = false; $("err").textContent = "";
    const p = status.portfolio || {};
    $("portfolio").innerHTML = [
      ["value", usd(p.totalValueUsd ?? p.currentValueUsd)],
      ["deposited", usd(p.totalDepositedUsd)],
      ["pnl", usd(p.unrealizedPnlUsd ?? p.totalPnlUsd)],
      ["cash", usd(p.availableUsd ?? p.cashUsd)],
      ["positions", status.portfolio ? (positions.positions || []).length : "—"],
      ["scans", status.scanCount],
      ["last cycle", ago(status.lastCycleAt)],
      ["uptime", status.uptimeMs ? Math.round(status.uptimeMs / 3600000) + "h" : "—"],
    ].map(([k, v]) => "<div class=card><div class=k>" + esc(k) + "</div><div class=v>" + esc(v) + "</div></div>").join("");
    $("positions").innerHTML = table(positions.positions, [
      { label: "pool", render: (r) => esc(String(r.poolAddress).slice(0, 10) + "…" + String(r.poolAddress).slice(-4)) },
      { label: "value", render: (r) => esc(usd(r.currentValueUsd)) },
      { label: "deposited", render: (r) => esc(usd(r.depositedUsd)) },
      { label: "pnl", render: (r) => { const d = (r.currentValueUsd || 0) - (r.depositedUsd || 0); return "<span class=" + (d >= 0 ? "pos" : "neg") + ">" + esc(usd(d)) + "</span>"; } },
      { label: "range", render: (r) => esc((r.lowerBinId ?? "?") + "…" + (r.upperBinId ?? "?")) },
      { label: "opened", render: (r) => esc(ago(r.openedAt ?? r.entryTimestamp)) },
    ]);
    $("decisions").innerHTML = table(decisions.decisions, [
      { label: "when", render: (r) => esc(ago(r.timestamp)) },
      { label: "pool", render: (r) => esc(String(r.poolAddress || "").slice(0, 10)) },
      { label: "action", render: (r) => esc(r.action) },
      { label: "conf", render: (r) => esc(num(r.confidence)) },
      { label: "reason", render: (r) => esc(String(r.reasoning || "").slice(0, 110)) },
    ]);
    $("config").innerHTML = table([config], Object.keys(config).map((k) => ({
      label: k, render: (r) => esc(typeof r[k] === "object" ? JSON.stringify(r[k]) : r[k]),
    })));
    $("tick").textContent = "updated " + new Date().toLocaleTimeString();
  } catch (e) {
    $("err").textContent = String(e.message || e);
    $("gate").hidden = false;
    if (e.message && e.message.startsWith("401")) sessionStorage.removeItem("beamToken");
  }
}
$("go").onclick = () => { token = $("token").value.trim(); sessionStorage.setItem("beamToken", token); refresh(); };
$("token").onkeydown = (e) => { if (e.key === "Enter") $("go").click(); };
if (token) refresh(); else $("gate").hidden = false;
setInterval(() => { if (token) refresh(); }, 10000);
</script></body></html>`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeConfig(cfg: AppConfig, _snapshot: BeamStateSnapshot) {
  return {
    paperTrading: cfg.paperTrading,
    scanIntervalMs: cfg.scanIntervalMs,
    minPoolTvlUsd: cfg.minPoolTvlUsd,
    minFeeIlRatio: cfg.minFeeIlRatio,
    tvlDropExitPct: cfg.tvlDropExitPct,
    volumeAuthThreshold: cfg.volumeAuthThreshold,
    confidenceThreshold: cfg.confidenceThreshold,
    paperPortfolioUsd: cfg.paperPortfolioUsd,
    minBinUtilization: cfg.minBinUtilization,
    maxRebalanceRangeBins: cfg.maxRebalanceRangeBins,
    maxOpenPositions: cfg.maxOpenPositions,
    stopLossPct: cfg.stopLossPct,
    trailingStopPct: cfg.trailingStopPct,
    agentiveMode: cfg.agentiveMode,
    agentRuntime: cfg.agentRuntime,
    agentHttpPort: cfg.agentHttpPort,
    agentMcpEnabled: cfg.agentMcpEnabled,
  };
}

export class HttpStatusServer {
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly state: AgentStateApi,
  ) {}

  /** The single read model behind every read endpoint on this server. */
  private operatorStatus(snapshot: BeamStateSnapshot): OperatorStatus {
    const positions = (snapshot.positions ?? []).map((position) =>
      positionStatusFromSnapshot(position),
    );
    const totalDepositedUsd = positions.reduce((sum, position) => sum + position.depositedUsd, 0);
    const portfolio = snapshot.portfolio ?? {
      totalValueUsd: 0,
      unrealizedPnlUsd: 0,
      realizedPnlUsd: 0,
      openPositions: 0,
      maxPositions: 0,
      walletBalanceUsd: 0,
    };
    const walletBalanceUsd = portfolio.walletBalanceUsd;
    const walletKnown = Number.isFinite(walletBalanceUsd);
    return buildOperatorStatus({
      source: "http",
      running: true,
      version: getCurrentVersion(),
      uptimeMs: Date.now() - (snapshot.programStartTime ?? Date.now()),
      scanCount: snapshot.scanCount ?? 0,
      lastCycleAt: snapshot.lastCycleAt ?? null,
      portfolio: {
        totalValueUsd: portfolio.totalValueUsd ?? 0,
        totalDepositedUsd,
        totalUnrealizedPnlUsd: portfolio.unrealizedPnlUsd ?? 0,
        totalUnrealizedPnlPct:
          totalDepositedUsd > 0
            ? ((portfolio.unrealizedPnlUsd ?? 0) / totalDepositedUsd) * 100
            : null,
        totalFeesClaimedUsd: null,
        totalRewardsClaimedUsd: null,
        walletBalanceUsd: walletKnown ? walletBalanceUsd : null,
        walletKnown,
        totalEquityUsd: (portfolio.totalValueUsd ?? 0) + (walletKnown ? walletBalanceUsd : 0),
        realizedPnlUsd: portfolio.realizedPnlUsd ?? null,
        positionCount: positions.length,
      },
      positions,
      decisions: (snapshot.recentDecisions ?? []).map((decision) => ({
        timestamp: decision.timestamp,
        cycleId: decision.cycleId,
        poolAddress: decision.poolAddress,
        action: decision.action,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
        executed: decision.executed,
        paperTrading: false,
        error: null,
      })),
      agentPolicy: snapshot.agentPolicy,
      config: sanitizeConfig(this.config, snapshot),
    });
  }

  private isAuthorized(request: Request, expectedToken: string): boolean {
    if (expectedToken.length === 0) return false;
    const authHeader = request.headers.get("Authorization") ?? "";
    const providedToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";
    const expectedBuf = Buffer.from(expectedToken);
    const actualBuf = Buffer.from(providedToken);
    return (
      actualBuf.length === expectedBuf.length && crypto.timingSafeEqual(actualBuf, expectedBuf)
    );
  }

  private async handlePropose(request: Request): Promise<Response> {
    const expectedToken = this.config.agentProposalToken;
    if (!this.isAuthorized(request, expectedToken)) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (!this.config.agentiveMode || this.config.agentProposalMode === "veto") {
      return new Response("Agent proposals are not consumed in the current mode", {
        status: 409,
      });
    }

    // Supervised mode can only consume human-approved proposals. Without an
    // approval token nothing can ever leave pending, so reject enqueue early
    // rather than accepting IDs that will only expire.
    if (
      this.config.agentProposalMode === "supervised" &&
      this.config.agentApprovalToken.length === 0
    ) {
      return Response.json(
        {
          error: "approval_token_required",
          message:
            "AGENT_PROPOSAL_MODE=supervised requires AGENT_APPROVAL_TOKEN so proposals can be approved",
        },
        { status: 409 },
      );
    }

    let parsedBody: unknown;
    try {
      parsedBody = await request.json();
    } catch (e) {
      if (e instanceof SyntaxError) {
        return new Response("Invalid JSON body", { status: 400 });
      }
      throw e;
    }

    const items = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
    const maxBatchSize = this.config.agentProposalMaxBatchSize;
    if (items.length > maxBatchSize) {
      return new Response(`Batch size ${items.length} exceeds limit ${maxBatchSize}`, {
        status: 413,
      });
    }

    const effect = Effect.gen({ self: this }, function* () {
      const proposals: AgentProposal[] = [];
      for (const [index, item] of items.entries()) {
        if (item === null || typeof item !== "object") {
          return new Response("Invalid proposal body", { status: 400 });
        }
        const raw = JSON.stringify(item);
        const proposal = yield* parseHttpQueueProposal(
          raw,
          crypto.randomUUID(),
          "http-queue",
          this.config.agentProposalStaleMs,
        ).pipe(
          Effect.mapError(
            (err) =>
              new ProposalParseError({
                message: `Invalid proposal at index ${index}: ${err.message}`,
              }),
          ),
        );
        proposals.push(proposal);
      }

      // Last-wins per pool within a single batch so we never advertise IDs that
      // were immediately superseded by a later item in the same request.
      const lastIndexByPool = new Map<string, number>();
      for (let i = 0; i < proposals.length; i++) {
        const pool = proposals[i]?.poolAddress;
        if (pool !== undefined) lastIndexByPool.set(pool, i);
      }
      const deduped = proposals.filter((p, i) => lastIndexByPool.get(p.poolAddress) === i);

      const snapshot = yield* this.state.getSnapshot();
      const scannableSet = new Set([
        ...this.config.watchlistPools,
        ...snapshot.positions.map((p) => p.poolAddress),
      ]);
      const acceptedIds: string[] = [];
      const replacedIds: string[] = [];
      const skipped: Array<{
        readonly poolAddress: string;
        readonly proposalId: string;
        readonly reason: "approved_exists";
      }> = [];
      const unscannable: Array<{ readonly poolAddress: string; readonly proposalId: string }> = [];
      for (const proposal of deduped) {
        if (!scannableSet.has(proposal.poolAddress)) {
          unscannable.push({ poolAddress: proposal.poolAddress, proposalId: proposal.proposalId });
          continue;
        }
        const result = yield* this.state.enqueueProposal(proposal);
        if (result.status === "rejected") {
          // Exhaustive on EnqueueProposalResult["reason"] so new reasons fail
          // closed (and TypeScript errors) instead of being silently dropped.
          switch (result.reason) {
            case "queue_full":
              // Global — fail closed for the rest of the batch.
              return Response.json(
                {
                  accepted: acceptedIds.length,
                  proposalIds: acceptedIds,
                  ...(replacedIds.length > 0 && { replacedIds }),
                  ...(skipped.length > 0 && { skipped }),
                  error: "queue_full",
                  message:
                    `Proposal queue full (max ${this.config.agentProposalMaxQueueSize})` +
                    (acceptedIds.length > 0
                      ? ` after accepting ${acceptedIds.length} of ${deduped.length}`
                      : ""),
                },
                { status: 503 },
              );
            case "approved_exists":
              // Pool-specific: skip this item and continue so healthy pools
              // in the same batch still enqueue.
              skipped.push({
                poolAddress: proposal.poolAddress,
                proposalId: proposal.proposalId,
                reason: "approved_exists",
              });
              continue;
            default: {
              const unexpected: never = result.reason;
              return Response.json(
                {
                  accepted: acceptedIds.length,
                  proposalIds: acceptedIds,
                  ...(replacedIds.length > 0 && { replacedIds }),
                  ...(skipped.length > 0 && { skipped }),
                  error: "enqueue_rejected",
                  message: `Unhandled enqueue rejection: ${String(unexpected)}`,
                },
                { status: 500 },
              );
            }
          }
        }
        if (result.status === "replaced") {
          replacedIds.push(...result.replacedIds);
        }
        if (result.status === "enqueued" || result.status === "replaced") {
          acceptedIds.push(proposal.proposalId);
        }
      }

      if (acceptedIds.length === 0 && skipped.length === 0 && unscannable.length > 0) {
        return Response.json(
          {
            accepted: 0,
            proposalIds: [],
            unscannable,
            error: "unscannable_pool",
            message:
              "Proposals target pool(s) not in the watchlist or held positions; add them to WATCHLIST_POOLS or hold a position in the pool",
          },
          { status: 400 },
        );
      }

      if (acceptedIds.length === 0 && skipped.length > 0) {
        return Response.json(
          {
            accepted: 0,
            proposalIds: [],
            skipped,
            ...(unscannable.length > 0 && { unscannable }),
            error: "approved_exists",
            poolAddresses: skipped.map((s) => s.poolAddress),
            message:
              "An approved proposal already exists for the requested pool(s); wait for it to execute or expire before re-proposing",
          },
          { status: 409 },
        );
      }

      return Response.json(
        {
          accepted: acceptedIds.length,
          proposalIds: acceptedIds,
          ...(replacedIds.length > 0 && { replacedIds }),
          ...(skipped.length > 0 && { skipped }),
          ...(unscannable.length > 0 && { unscannable }),
        },
        { status: 202 },
      );
    }).pipe(
      Effect.catchTag("ProposalParseError", (err) =>
        Effect.succeed(new Response(err.message, { status: 400 })),
      ),
    );

    return await Effect.runPromise(effect);
  }

  private async handleApprove(request: Request): Promise<Response> {
    // Fail-closed: approve requires an explicit approval token. Do not fall
    // back to the proposal enqueue credential — that would collapse the
    // supervised human boundary if a single token leaks.
    const expectedToken = this.config.agentApprovalToken;
    if (!this.isAuthorized(request, expectedToken)) {
      return new Response("Unauthorized", { status: 401 });
    }

    let parsedBody: unknown;
    try {
      parsedBody = await request.json();
    } catch (e) {
      if (e instanceof SyntaxError) {
        return new Response("Invalid JSON body", { status: 400 });
      }
      throw e;
    }

    if (!isRecord(parsedBody) || !Array.isArray(parsedBody.proposalIds)) {
      return new Response("Missing proposalIds array", { status: 400 });
    }

    const proposalIds = parsedBody.proposalIds;
    if (!proposalIds.every((id): id is string => typeof id === "string")) {
      return new Response("proposalIds must be an array of strings", { status: 400 });
    }

    const maxBatchSize = this.config.agentProposalMaxBatchSize;
    if (proposalIds.length > maxBatchSize) {
      return new Response(`Batch size ${proposalIds.length} exceeds limit ${maxBatchSize}`, {
        status: 413,
      });
    }

    const snapshot = await Effect.runPromise(this.state.getSnapshot());
    const pendingIds = new Set(snapshot.pendingProposals.map((p) => p.proposalId));
    const missing = proposalIds.filter((id) => !pendingIds.has(id));
    if (missing.length > 0) {
      return Response.json({ error: "Proposal IDs not found", missing }, { status: 404 });
    }

    for (const proposalId of proposalIds) {
      await Effect.runPromise(this.state.approveProposal(proposalId));
    }

    return Response.json({ approved: proposalIds.length }, { status: 200 });
  }

  start(): Effect.Effect<void, Error> {
    return Effect.sync(() => {
      if (this.server) return;
      const port = this.config.agentHttpPort;
      if (port === 0) return;

      this.server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch: async (request) => {
          const url = new URL(request.url);
          const snapshot = await Effect.runPromise(this.state.getSnapshot());

          // Read-only dashboard shell. Static HTML with no state in it: the page
          // asks for the read token once (kept in sessionStorage, never in the
          // URL so it cannot land in access logs) and then pulls the same
          // token-gated JSON endpoints a CLI would. Loopback-only bind, no
          // write path, no external assets.
          if (url.pathname === "/") {
            return new Response(DASHBOARD_HTML, {
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          }

          if (url.pathname === "/health") {
            return Response.json({
              ok: true,
              uptimeMs: Date.now() - snapshot.programStartTime,
              version: getCurrentVersion(),
            });
          }

          // Read endpoints expose portfolio/positions/decisions on loopback;
          // require the same Bearer credential as /propose (fail-closed when
          // no token is configured). Only /health stays open as a liveness probe.
          if (
            url.pathname === "/status" ||
            url.pathname === "/positions" ||
            url.pathname === "/decisions" ||
            url.pathname === "/config" ||
            url.pathname === "/agent-policy"
          ) {
            if (!this.isAuthorized(request, this.config.agentProposalToken)) {
              return new Response("Unauthorized", { status: 401 });
            }
          }

          const status = this.operatorStatus(snapshot);

          if (url.pathname === "/status") {
            return Response.json(status);
          }

          if (url.pathname === "/positions") {
            const pool = url.searchParams.get("pool");
            const positions = pool
              ? status.positions.filter((position) => position.poolAddress === pool)
              : status.positions;
            return Response.json({ positions });
          }

          if (url.pathname === "/decisions") {
            const limitParam = parseInt(url.searchParams.get("limit") ?? "10", 10);
            const limit = Math.min(
              Math.max(0, Number.isFinite(limitParam) && limitParam >= 0 ? limitParam : 10),
              100,
            );
            const pool = url.searchParams.get("pool");
            let decisions = status.decisions;
            if (pool) {
              decisions = decisions.filter((decision) => decision.poolAddress === pool);
            }
            return Response.json({ decisions: decisions.slice(0, limit) });
          }

          if (url.pathname === "/config") {
            return Response.json(status.config ?? {});
          }

          if (url.pathname === "/agent-policy") {
            return Response.json(status.agentPolicy);
          }

          if (url.pathname === "/propose") {
            return this.handlePropose(request);
          }

          if (url.pathname === "/approve") {
            return this.handleApprove(request);
          }

          return new Response("Not found", { status: 404 });
        },
      });

      logger.info("HTTP status server listening", { port });
    });
  }

  stop(): Effect.Effect<void, Error> {
    return Effect.sync(() => {
      if (this.server) {
        // closeActiveConnections avoids TIME_WAIT races when tests rebind ports.
        void this.server.stop(true);
        this.server = null;
        logger.info("HTTP status server stopped");
      }
    });
  }
}

export function HttpStatusServerLive(
  config: AppConfig,
): Layer.Layer<HttpStatusServerService, never, AgentStateService> {
  return Layer.effect(
    HttpStatusServerService,
    Effect.gen(function* () {
      const state = yield* AgentStateService;
      const server = new HttpStatusServer(config, state);
      return {
        start: () =>
          server.start().pipe(
            Effect.catch((err) => {
              logger.error("HTTP status server failed", { error: String(err) });
              return Effect.void;
            }),
          ),
        stop: () =>
          server.stop().pipe(
            Effect.catch((err) => {
              logger.error("HTTP status server stop failed", { error: String(err) });
              return Effect.void;
            }),
          ),
      };
    }),
  );
}
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof */
