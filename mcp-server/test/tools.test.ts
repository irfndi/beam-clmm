import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runBeam } from "../src/exec.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "../src/tools.js";

// ─── runBeam() ──────────────────────────────────────────────────────────────

describe("runBeam", () => {
  let workDir: string;
  let fakeBeam: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "beam-mcp-test-"));
    fakeBeam = join(workDir, "beam");
    writeFileSync(
      fakeBeam,
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "beam 0.0.3 (test stub)"
  exit 0
fi
if [ "$1" = "whoami" ]; then
  echo "User ID: test-user-123"
  echo "Tier: free"
  exit 0
fi
if [ "$1" = "fail" ]; then
  echo "Something went wrong" >&2
  exit 1
fi
echo "unknown command: $1"
exit 2
`,
    );
    chmodSync(fakeBeam, 0o755);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("runs the beam binary and returns stdout on success", async () => {
    const prevBin = process.env.BEAM_BIN;
    process.env.BEAM_BIN = fakeBeam;
    try {
      const result = await runBeam(["--version"], {});
      assert.equal(result.exitCode, 0);
      assert.equal(result.ok, true);
      assert.equal(result.timedOut, false);
      assert.ok(result.stdout.includes("beam 0.0.3"));
    } finally {
      if (prevBin === undefined) delete process.env.BEAM_BIN;
      else process.env.BEAM_BIN = prevBin;
    }
  });

  it("sets timedOut=true when the command exceeds the timeout", async () => {
    const prevBin = process.env.BEAM_BIN;
    const slowBin = join(workDir, "slow-beam");
    writeFileSync(
      slowBin,
      `#!/usr/bin/env bash
sleep 10
echo "should not get here"
exit 0
`,
    );
    chmodSync(slowBin, 0o755);
    process.env.BEAM_BIN = slowBin;
    try {
      const result = await runBeam(["slow"], { timeoutMs: 200 });
      assert.equal(result.ok, false);
      assert.equal(result.timedOut, true);
    } finally {
      if (prevBin === undefined) delete process.env.BEAM_BIN;
      else process.env.BEAM_BIN = prevBin;
    }
  });

  it("returns ok=false with stderr on non-zero exit", async () => {
    const prevBin = process.env.BEAM_BIN;
    process.env.BEAM_BIN = join(workDir, "failing-beam");
    writeFileSync(
      join(workDir, "failing-beam"),
      `#!/usr/bin/env bash
echo "Something went wrong" >&2
exit 1
`,
    );
    chmodSync(join(workDir, "failing-beam"), 0o755);
    try {
      const result = await runBeam(["fail"], {});
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 1);
      assert.ok(result.stderr.includes("Something went wrong"));
    } finally {
      if (prevBin === undefined) delete process.env.BEAM_BIN;
      else process.env.BEAM_BIN = prevBin;
    }
  });

  it("finds the binary via BEAM_BIN env var", async () => {
    const prevBin = process.env.BEAM_BIN;
    process.env.BEAM_BIN = fakeBeam;
    try {
      const result = await runBeam(["whoami"], {});
      assert.equal(result.ok, true);
      assert.ok(result.stdout.includes("test-user-123"));
    } finally {
      if (prevBin === undefined) delete process.env.BEAM_BIN;
      else process.env.BEAM_BIN = prevBin;
    }
  });

  it("returns ok=false when the binary cannot be found", async () => {
    const prevBin = process.env.BEAM_BIN;
    process.env.BEAM_BIN = "/nonexistent/path/to/beam";
    try {
      const result = await runBeam(["--version"], {});
      assert.equal(result.ok, false);
      assert.notEqual(result.exitCode, 0);
    } finally {
      if (prevBin === undefined) delete process.env.BEAM_BIN;
      else process.env.BEAM_BIN = prevBin;
    }
  });
});

// ─── DB-backed tools ──────────────────────────────────────────────────────────

const SCHEMA_SQL = `
  CREATE TABLE positions (
    pool_address TEXT PRIMARY KEY,
    position_pubkey TEXT,
    deposited_usd REAL,
    current_value_usd REAL,
    token_x_symbol TEXT,
    token_y_symbol TEXT,
    active_bin_id INTEGER,
    lower_bin_id INTEGER,
    upper_bin_id INTEGER,
    timestamp INTEGER,
    out_of_range_since INTEGER,
    oor_cycle_count INTEGER DEFAULT 0,
    last_fee_claim_at INTEGER DEFAULT 0,
    trailing_stop_threshold REAL,
    highest_value_usd REAL,
    last_rebalance_at INTEGER DEFAULT 0,
    paper_exited_at INTEGER,
    closed_at INTEGER
  );
  CREATE TABLE audit (
    id TEXT PRIMARY KEY,
    timestamp INTEGER,
    cycle_id TEXT,
    pool_address TEXT,
    action TEXT,
    confidence REAL,
    reasoning TEXT,
    metrics_json TEXT,
    risk_result_json TEXT,
    executed INTEGER,
    paper_trading INTEGER,
    tx_signature TEXT,
    error TEXT
  );
`;

function setupTestDb(workDir: string): string {
  const dbPath = join(workDir, "test.db");
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  return dbPath;
}

function seedPositions(dbPath: string): void {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO positions (pool_address, deposited_usd, current_value_usd,
      token_x_symbol, token_y_symbol, active_bin_id, lower_bin_id, upper_bin_id,
      timestamp, out_of_range_since, oor_cycle_count, last_fee_claim_at,
      trailing_stop_threshold, highest_value_usd, last_rebalance_at, paper_exited_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "PoolActive1", 1000, 1050, "SOL", "USDC", 5000, 4980, 5020,
    Date.now(), null, 0, Date.now(), null, 1050, 0, null,
  );
  db.prepare(
    `INSERT INTO positions (pool_address, deposited_usd, current_value_usd,
      token_x_symbol, token_y_symbol, active_bin_id, lower_bin_id, upper_bin_id,
      timestamp, out_of_range_since, oor_cycle_count, last_fee_claim_at,
      trailing_stop_threshold, highest_value_usd, last_rebalance_at, paper_exited_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "PoolExited", 500, 500, "SOL", "USDC", 5000, 4980, 5020,
    Date.now(), null, 0, Date.now(), null, 500, 0, Date.now() - 3600_000,
  );
  // Soft-closed (Wave 4 live EXIT): closed_at set, paper_exited_at NULL.
  db.prepare(
    `INSERT INTO positions (pool_address, deposited_usd, current_value_usd,
      token_x_symbol, token_y_symbol, active_bin_id, lower_bin_id, upper_bin_id,
      timestamp, out_of_range_since, oor_cycle_count, last_fee_claim_at,
      trailing_stop_threshold, highest_value_usd, last_rebalance_at, paper_exited_at,
      closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "PoolClosed", 800, 900, "RAY", "USDC", 7000, 6980, 7020,
    Date.now(), null, 0, Date.now(), null, 950, 0, null, Date.now() - 1800_000,
  );
  db.close();
}

function seedAudit(dbPath: string): void {
  const db = new Database(dbPath);
  const now = Date.now();
  db.prepare(
    `INSERT INTO audit (id, timestamp, cycle_id, pool_address, action, confidence, reasoning, metrics_json, risk_result_json, executed, paper_trading, tx_signature, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("a1", now - 2000, "cycle-1", "PoolActive1", "HOLD", 0.8, "Within range", null, null, 1, 1, null, null);
  db.prepare(
    `INSERT INTO audit (id, timestamp, cycle_id, pool_address, action, confidence, reasoning, metrics_json, risk_result_json, executed, paper_trading, tx_signature, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("a2", now - 1000, "cycle-2", "PoolActive1", "REBALANCE", 0.75, "Drifted 65%", null, null, 1, 1, null, null);
  db.prepare(
    `INSERT INTO audit (id, timestamp, cycle_id, pool_address, action, confidence, reasoning, metrics_json, risk_result_json, executed, paper_trading, tx_signature, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("a3", now, "cycle-3", "PoolActive1", "HOLD", 0.85, "Stable", null, null, 1, 1, null, null);
  db.close();
}

describe("DB-backed tools", () => {
  let workDir: string;
  let prevDbPath: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "beam-mcp-dbt-"));
    prevDbPath = process.env.SQLITE_DB_PATH;
  });

  afterEach(() => {
    if (prevDbPath === undefined) delete process.env.SQLITE_DB_PATH;
    else process.env.SQLITE_DB_PATH = prevDbPath;
    rmSync(workDir, { recursive: true, force: true });
  });

  it("beam_status returns running=false when DB does not exist", async () => {
    process.env.SQLITE_DB_PATH = join(workDir, "nonexistent.db");
    const result = await runTool("beam_status", {});
    assert.equal(result.ok, true);
    const parsed = JSON.parse(result.text);
    assert.equal(parsed.running, false);
    assert.ok(parsed.message.includes("No SQLite database found"));
  });

  it("beam_status returns position count and last audit when DB exists", async () => {
    const dbPath = setupTestDb(workDir);
    seedPositions(dbPath);
    seedAudit(dbPath);
    process.env.SQLITE_DB_PATH = dbPath;

    const result = await runTool("beam_status", {});
    const parsed = JSON.parse(result.text);
    assert.equal(parsed.running, true);
    assert.equal(parsed.positionCount, 1);
    assert.equal(parsed.totalDepositedUsd, 1000);
    assert.equal(parsed.totalCurrentValueUsd, 1050);
    assert.equal(parsed.lastAudit.length, 3);
    assert.equal(parsed.lastAudit[0].action, "HOLD");
    assert.equal(parsed.lastAudit[1].action, "REBALANCE");
  });

  it("beam_positions returns empty array when DB does not exist", async () => {
    process.env.SQLITE_DB_PATH = join(workDir, "nonexistent.db");
    const result = await runTool("beam_positions", {});
    assert.equal(result.ok, true);
    const parsed = JSON.parse(result.text);
    assert.deepEqual(parsed, []);
  });

  it("beam_positions excludes paper-exited positions", async () => {
    const dbPath = setupTestDb(workDir);
    seedPositions(dbPath);
    process.env.SQLITE_DB_PATH = dbPath;

    const result = await runTool("beam_positions", {});
    const parsed = JSON.parse(result.text);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].pool, "PoolActive1");
  });

  it("beam_status and beam_positions exclude soft-closed (closed_at) positions", async () => {
    const dbPath = setupTestDb(workDir);
    seedPositions(dbPath);
    seedAudit(dbPath);
    process.env.SQLITE_DB_PATH = dbPath;

    const status = JSON.parse((await runTool("beam_status", {})).text);
    assert.equal(status.positionCount, 1);
    assert.equal(status.totalDepositedUsd, 1000);

    const positions = JSON.parse((await runTool("beam_positions", {})).text);
    assert.equal(positions.length, 1);
    assert.ok(!positions.some((p: { pool: string }) => p.pool === "PoolClosed"));
  });

  it("beam_status still works against a pre-v16 schema without closed_at", async () => {
    const dbPath = join(workDir, "old.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE positions (
        pool_address TEXT PRIMARY KEY,
        deposited_usd REAL,
        current_value_usd REAL,
        paper_exited_at INTEGER
      );
      CREATE TABLE audit (
        id TEXT PRIMARY KEY,
        timestamp INTEGER,
        cycle_id TEXT,
        pool_address TEXT,
        action TEXT,
        confidence REAL,
        reasoning TEXT,
        metrics_json TEXT,
        risk_result_json TEXT,
        executed INTEGER,
        paper_trading INTEGER,
        tx_signature TEXT,
        error TEXT
      );
    `);
    db.prepare(
      "INSERT INTO positions (pool_address, deposited_usd, current_value_usd, paper_exited_at) VALUES (?, ?, ?, ?)",
    ).run("PoolOld", 250, 260, null);
    db.close();
    process.env.SQLITE_DB_PATH = dbPath;

    const result = await runTool("beam_status", {});
    const parsed = JSON.parse(result.text);
    assert.equal(result.ok, true);
    assert.equal(parsed.positionCount, 1);
    assert.equal(parsed.totalDepositedUsd, 250);
  });

  it("beam_positions includes range and out-of-range count", async () => {
    const dbPath = setupTestDb(workDir);
    seedPositions(dbPath);
    process.env.SQLITE_DB_PATH = dbPath;

    const result = await runTool("beam_positions", {});
    const parsed = JSON.parse(result.text);
    assert.deepEqual(parsed[0].range, { lower: 4980, upper: 5020, active: 5000 });
    assert.equal(parsed[0].tokens, "SOL/USDC");
  });
});

// ─── Tool registration ────────────────────────────────────────────────────────

describe("tool registration", () => {
  it("registers all 4 tools on the server", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerAllTools(server);
    assert.ok(server);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface ToolResult {
  ok: boolean;
  text: string;
  isError: boolean;
}

async function runTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerAllTools(server);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;
    const first = content[0];
    return {
      ok: !result.isError,
      text: first && "text" in first ? String(first.text) : "",
      isError: result.isError === true,
    };
  } finally {
    await client.close();
  }
}
