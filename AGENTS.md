# AGENTS.md

Notes for AI agent harnesses working in `beam-clmm`. This repo was scaffolded
from `irfndi/prism-liquidity-agent` (Solana / Meteora DLMM) and is being
refactored into an autonomous concentrated-liquidity agent for **Uniswap v3 &
v4 on Robinhood Chain** (EVM, chain id 4663), deployed on Cloudflare via the
Alchemy framework. The refactor is IN PROGRESS — the code does not compile
until the EVM adapter seam is rebuilt. See `.ulw-notepad.md` for the current
handoff state and next steps.

## Project

Beam is an autonomous liquidity agent: it scans a set of Uniswap v3/v4 pools
on Robinhood Chain, evaluates each pool with a rule-based strategy, and
decides **HOLD / ENTER / REBALANCE / EXIT**. Paper trading is the default;
live on-chain execution requires an EVM wallet private key and
`PAPER_TRADING=false`.

The engine architecture (Effect-TS services, decision loop, risk gates,
SQLite state, memory, alerts) carries over from Prism unchanged in shape; the
chain-specific layer is being rewritten Solana → EVM.

## Verified chain facts (2026-08)

| Item | Value |
|---|---|
| Chain | Robinhood Chain, EVM L2, chain id `4663` (testnet `46630`) |
| Native gas token | ETH |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` |
| Stablecoin | USDG (Paxos Global Dollar), 6 decimals, `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| Uniswap v3 factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| Uniswap v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| v4 PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` |
| v4 Quoter / StateView | `0x8dc178eFB8111BB0973Dd9d722ebeFF267c98F94` / `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` |
| Universal Router | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

viem does not ship a built-in chain for 4663 — define it with
`defineChain({ id: 4663, ... })` (see handoff). `@uniswap/v3-sdk` +
`@uniswap/v4-sdk` + `@uniswap/sdk-core` + `viem` are already in
`package.json`.

## Current state

- Removed: all Solana/Meteora modules (`adapter-service`, `meteora-datapi`,
  `gecko-*`, `entry-prep`, `entry-sol-budget`, `rewards`, `token-risk`,
  `rugcheck`, `screener`, `market-gate`, `candidate-*`, `fallen-angel-*`,
  `tp-ladder`, `discovery-policy`, revenue/referral services) and their
  tests. `cli/doctor.ts`, `cli/wallet.ts`, `ops/fetch-history.ts` removed.
- Renamed: `prism` → `beam` everywhere (env vars `PRISM_*` → `BEAM_*`, config
  dir, CLI binary `beam`, `scripts/beam.sh`, skills, packages).
- `engine/constants.ts` rewritten for EVM (ETH native, USDG, wei reserves).
  `cli/setup.ts` / `ops/setup.ts` now prompt for `ROBINHOOD_RPC_URL`.
- **Broken seam (next agent's job #1):** `engine/types.ts`, `engine/services.ts`
  (AdapterService Tag), `engine/program.ts`, `engine/config-service.ts`,
  `engine/strategy-service.ts`, `engine/risk-service.ts`, `cli/portfolio.ts`,
  `ops/backtest.ts` still carry Solana shapes and import deleted modules.
  Tests importing `program.ts` / `services.ts` (decision-loop-*,
  multi-position, idle-redeploy, il-protection, metrics-*, pnl-accounting,
  reconcile-positions, volatility-adaptive-range, program.test) will fail
  until the seam is ported.

## Build / test

```bash
bun install
bun run lint        # tsc --noEmit && oxlint
bun run format      # oxfmt --write
bun run test        # vitest (bench/**, Bun required)
```

## Conventions (kept from Prism)

- Effect-TS: side effects in services (`Context.Tag` + `Layer`), `Effect.gen`
  for sequences, `Effect.catchAll` for recoverable errors.
- Strict TS: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- No `any`. Logging via `createLogger(component)` (engine/logger.ts).
- Risk gates: numbered early-return blocks in `engine/risk-service.ts`.
- Paper trading first: new execution paths must work in paper mode.
- BigInt JSON via `stringifySafe` from `engine/bigint-json.ts`.
- Tests in `bench/**/*.test.ts`, run with Vitest under Bun.

## Where to look first

- Handoff + next steps: `.ulw-notepad.md`
- Seam to rebuild: `engine/services.ts` → `engine/types.ts` → new
  `engine/adapter-service.ts` → `engine/program.ts`
- Deployment target: Cloudflare Workers + D1 via Alchemy (`bun alchemy deploy`),
  see handoff; the old `cloudflare/` wrangler subproject still exists but is
  the legacy deployment path.
