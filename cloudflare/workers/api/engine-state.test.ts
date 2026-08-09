import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker, { type Env } from "./index";

// D1 engine-state surface: engine pushes per-cycle snapshots + decisions
// through /v1/agent-status/report; the operator surface reads them via
// GET /v1/engine/state. Same auth (Bearer API key) as the legacy heartbeat.

const testEnv = { ...env } as unknown as Env;

function buildRequest(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request(`https://example.com${path}`, init);
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("Engine state surface (D1)", () => {
  let apiKey = "test-engine-key";

  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        telegram_id TEXT UNIQUE,
        tier TEXT NOT NULL DEFAULT 'free',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS api_keys (
        key_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS engine_snapshots (
        agent_id TEXT NOT NULL,
        reported_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        positions INTEGER NOT NULL,
        pnl REAL NOT NULL,
        details TEXT,
        PRIMARY KEY (agent_id, reported_at)
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS engine_decisions (
        agent_id TEXT NOT NULL,
        reported_at INTEGER NOT NULL,
        pool_address TEXT NOT NULL,
        action TEXT NOT NULL,
        confidence REAL NOT NULL,
        reasoning TEXT NOT NULL,
        executed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, reported_at, pool_address, action)
      )`,
    ).run();
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM engine_decisions").run();
    await env.DB.prepare("DELETE FROM engine_snapshots").run();
    await env.DB.prepare("DELETE FROM api_keys").run();
    await env.DB.prepare("DELETE FROM users").run();
    await env.DB.prepare("INSERT INTO users (id) VALUES ('user-1')").run();
    const keyHash = await sha256Hex(apiKey);
    await env.DB
      .prepare("INSERT INTO api_keys (key_hash, user_id) VALUES (?, 'user-1')")
      .bind(keyHash)
      .run();
  });

  it("stores a report with decisions in D1 and reads them back", async () => {
    const ctx = createExecutionContext();
    const report = buildRequest(
      "POST",
      "/v1/agent-status/report",
      {
        status: "running",
        positions: 2,
        pnl: 12.5,
        decisions: [
          {
            poolAddress: "0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca",
            action: "ENTER",
            confidence: 0.8,
            reasoning: "strong volume/TVL signals",
            executed: false,
          },
          {
            poolAddress: "0xa9188730fe85be88ad499d7d52b099e800fb0334",
            action: "HOLD",
            confidence: 0.5,
            reasoning: "no strong signal",
            executed: false,
          },
        ],
      },
      { Authorization: `Bearer ${apiKey}` },
    );
    const reportResponse = await worker.fetch(report, testEnv, ctx);
    expect(reportResponse.status).toBe(200);
    expect(await reportResponse.json()).toEqual({ ok: true });

    // Read side
    const read = buildRequest("GET", "/v1/engine/state?limit=10", undefined, {
      Authorization: `Bearer ${apiKey}`,
    });
    const readResponse = await worker.fetch(read, testEnv, ctx);
    expect(readResponse.status).toBe(200);
    const body = (await readResponse.json()) as {
      snapshot: { status: string; positions: number; pnl: number } | null;
      decisions: ReadonlyArray<{ action: string; poolAddress: string }>;
    };
    expect(body.snapshot).toMatchObject({ status: "running", positions: 2, pnl: 12.5 });
    expect(body.decisions).toHaveLength(2);
    expect(body.decisions.map((d) => d.action).sort()).toEqual(["ENTER", "HOLD"]);
  });

  it("round-trips the trade ledger through the portfolio surface", async () => {
    const ctx = createExecutionContext();
    const trades = [
      {
        id: "paper-1",
        poolAddress: "0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca",
        side: "open" as const,
        depositedUsd: 500,
        valueUsd: 501.25,
        pnlUsd: 1.25,
        feesUsd: 0.02,
        openedAt: 1786200000000,
        exitedAt: null,
      },
      {
        id: "paper-2",
        poolAddress: "0xa9188730fe85be88ad499d7d52b099e800fb0334",
        side: "closed" as const,
        depositedUsd: 218.47,
        valueUsd: 220.17,
        pnlUsd: 1.7,
        feesUsd: 0,
        openedAt: 1786200000000,
        exitedAt: 1786280000000,
      },
    ];
    const report = buildRequest(
      "POST",
      "/v1/agent-status/report",
      { status: "running", positions: 2, pnl: 2.95, trades },
      { Authorization: `Bearer ${apiKey}` },
    );
    const reportResponse = await worker.fetch(report, testEnv, ctx);
    expect(reportResponse.status).toBe(200);

    // Dedicated portfolio endpoint: trades + derived stats.
    const portfolio = buildRequest("GET", "/v1/engine/portfolio", undefined, {
      Authorization: `Bearer ${apiKey}`,
    });
    const portfolioResponse = await worker.fetch(portfolio, testEnv, ctx);
    expect(portfolioResponse.status).toBe(200);
    const portfolioBody = (await portfolioResponse.json()) as {
      trades: ReadonlyArray<{ id: string; side: string }>;
      stats: {
        totalPositions: number;
        open: number;
        closed: number;
        deployedUsd: number;
        realizedPnl: number;
        unrealizedPnl: number;
        feesClaimedUsd: number;
        totalPnl: number;
      };
    };
    expect(portfolioBody.trades).toHaveLength(2);
    expect(portfolioBody.stats).toEqual({
      totalPositions: 2,
      open: 1,
      closed: 1,
      deployedUsd: 500,
      realizedPnl: 1.7,
      unrealizedPnl: 1.25,
      feesClaimedUsd: 0.02,
      totalPnl: 2.95,
    });

    // The state endpoint carries the same ledger.
    const state = buildRequest("GET", "/v1/engine/state", undefined, {
      Authorization: `Bearer ${apiKey}`,
    });
    const stateBody = (await (await worker.fetch(state, testEnv, ctx)).json()) as {
      trades: ReadonlyArray<{ id: string }>;
    };
    expect(stateBody.trades.map((t) => t.id).sort()).toEqual(["paper-1", "paper-2"]);
  });

  it("rejects unauthenticated reads and reports", async () => {
    const ctx = createExecutionContext();
    const badReport = buildRequest("POST", "/v1/agent-status/report", {
      status: "running",
      positions: 0,
      pnl: 0,
    });
    const reportResponse = await worker.fetch(badReport, testEnv, ctx);
    expect(reportResponse.status).toBe(401);

    const badRead = buildRequest("GET", "/v1/engine/state");
    const readResponse = await worker.fetch(badRead, testEnv, ctx);
    expect(readResponse.status).toBe(401);
  });

  it("validates report payload shape", async () => {
    const ctx = createExecutionContext();
    const invalid = buildRequest(
      "POST",
      "/v1/agent-status/report",
      { status: "running", positions: -1, pnl: 0 },
      { Authorization: `Bearer ${apiKey}` },
    );
    const response = await worker.fetch(invalid, testEnv, ctx);
    expect(response.status).toBe(400);
  });
});
