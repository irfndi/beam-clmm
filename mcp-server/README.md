# @irfndi/beam-mcp

Model Context Protocol (MCP) server that exposes Beam liquidity agent commands as tools for Claude Desktop and other MCP clients.

## What it does

Exposes 4 tools to any MCP-compatible client (Claude Desktop, Claude Code, Cursor, etc.):

| Tool | What it does |
|---|---|
| `beam_status` | Reads the SQLite DB to return position count, total deposited/current value (USD), and the last 3 audit entries |
| `beam_positions` | Lists all active positions (excludes paper-exited ones) with tokens, range, deposited/current value, and out-of-range cycle count |
| `beam_whoami` | Shows cloud account info (requires `beam register` first) |
| `beam_backtest` | Runs a backtest — `synthetic` (default, deterministic mock) or `replay` (reads from beam.db snapshots) |

## Install

### From npm (once published)

```bash
npm install -g @irfndi/beam-mcp
```

### From the repo (current state)

```bash
cd mcp-server
npm install
npm run build
```

This produces `mcp-server/dist/index.js` — the stdio MCP server entry point.

## Configure Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "beam": {
      "command": "node",
      "args": ["/absolute/path/to/beam-clmm/mcp-server/dist/index.js"],
      "env": {
        "BEAM_BIN": "/absolute/path/to/beam",
        "SQLITE_DB_PATH": "/absolute/path/to/beam.db"
      }
    }
  }
}
```

Notes:
- `BEAM_BIN` is the absolute path to the `beam` wrapper. If you used the one-liner installer, this is `~/.local/bin/beam`.
- `SQLITE_DB_PATH` is the absolute path to `beam.db`. If omitted, the server tries `./beam.db` relative to its CWD.
- If `beam` is on your `PATH` and `beam.db` is in the server's CWD, you can omit both `env` entries.

Restart Claude Desktop. The `beam` server will appear in the MCP tools list with the 4 tools above.

## Verify the server starts

```bash
# Should hang waiting for stdio input (Ctrl+C to exit)
node /absolute/path/to/mcp-server/dist/index.js
```

If it crashes immediately, check:
1. `BEAM_BIN` points to a working `beam` binary — test with `$BEAM_BIN --version`
2. `SQLITE_DB_PATH` points to a readable SQLite file (or omit to use `./beam.db`)
3. `better-sqlite3` native binding is built — run `npm rebuild better-sqlite3` in the mcp-server directory

## Tool details

### `beam_status`

No parameters. Returns:

```json
{
  "running": true,
  "dbPath": "./beam.db",
  "positionCount": 2,
  "totalDepositedUsd": 1500.00,
  "totalCurrentValueUsd": 1620.50,
  "lastAudit": [
    {
      "timestamp": "2026-06-03T15:00:00.000Z",
      "action": "ENTER",
      "pool": "Pool...",
      "reasoning": "Fee/IL ratio 1.8 above threshold",
      "paperTrading": true
    }
  ]
}
```

If the SQLite DB doesn't exist (agent hasn't run yet), returns `{ running: false, message: "..." }`.

### `beam_positions`

No parameters. Returns an array of active positions:

```json
[
  {
    "pool": "Pool...",
    "tokens": "SOL/USDC",
    "depositedUsd": 1000.00,
    "currentValueUsd": 1080.20,
    "range": { "lower": 4980, "upper": 5020, "active": 5005 },
    "outOfRangeCycleCount": 0,
    "lastRebalanceAt": null
  }
]
```

### `beam_whoami`

No parameters. Shells out to `beam whoami`. Returns the CLI's stdout on success, or a structured `{ registered: false, message: "..." }` if not registered.

### `beam_backtest`

Parameters:
- `source` (enum, default `synthetic`): `synthetic` for deterministic mock data, `replay` for on-chain snapshots from `beam.db`
- `days` (int 1-365, default 7): number of days to backtest
- `pools` (array of strings, optional, replay only): pool addresses to backtest

Returns the CLI's stdout. Errors include the exit code and stderr.

## How it finds the Beam binary

Resolution order:
1. `BEAM_BIN` env var (absolute path)
2. `~/.local/bin/beam` (default one-liner install location)
3. `~/.bun/bin/beam` (Bun global install location)
4. `beam` on `PATH`

If none of these resolve, the tool calls will fail with a clear error message.

## Security

The MCP server runs locally and only exposes read-only operations (SQLite is opened in readonly mode). The `beam_whoami` and `beam_backtest` tools spawn the Beam CLI as a subprocess with a 30-120 second timeout.

No data is sent to external services. The server is a stdio-only process that only responds to the local MCP client.

## Development

```bash
cd mcp-server
npm install                    # installs deps + builds better-sqlite3 native binding
npm run dev                    # tsc --watch
npm run build                  # tsc
npm test                       # node --import tsx --test test/*.test.ts
```

### Build requirement: better-sqlite3 native binding

`better-sqlite3` is a native module that needs to be compiled for the target Node.js version. The `npm install` step should automatically download a prebuilt binary, but on very new Node.js versions (e.g., v26) or systems without build tools, the build may fall back to compiling from source, which requires:
- macOS: Xcode Command Line Tools (`xcode-select --install`)
- Linux: Python 3, make, g++
- Windows: windows-build-tools

If `npm test` fails with `node-gyp` errors, run `npm rebuild better-sqlite3` to force a rebuild, or use a Node.js version with available prebuilds (v18-v22 are well-supported).

## Future work (not in this package)

- **Resource providers** for pool metadata, audit log history, etc.
- **Sampling support** for tool-driven LLM completions
- **HTTP transport** (currently stdio only) for remote MCP clients
- **Prompts** for common Beam workflows (install, diagnose, backtest)
- **OAuth** for multi-user setups

## License

MIT — same as the main Beam project.
