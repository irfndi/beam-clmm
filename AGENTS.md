# AGENTS.md

Notes for AI agent harnesses working in `beam-clmm`. This repo was scaffolded
from `irfndi/prism-liquidity-agent` (Solana / Meteora DLMM) and has been
ported into an autonomous concentrated-liquidity agent for **Uniswap v3 & v4
on Robinhood Chain** (EVM, chain id 4663), deployed on Cloudflare via the
Alchemy framework. The EVM port is COMPLETE: the code compiles, typechecks,
and the full test suite passes. See `.ulw-notepad.md` for the verified
chain-fact handoff and `.github/workflows/deploy-cloudflare.yml` for the
deployment path.

## Project

Beam is an autonomous liquidity agent: it scans a set of Uniswap v3/v4 pools
on Robinhood Chain, evaluates each pool with a rule-based strategy, and
decides **HOLD / ENTER / REBALANCE / EXIT**. Paper trading is the default;
live on-chain execution requires an EVM wallet private key and
`PAPER_TRADING=false`.

The engine architecture (Effect-TS services, decision loop, risk gates,
SQLite state, memory, alerts) carries over from Prism unchanged in shape; the
chain-specific layer is fully ported to EVM (`engine/adapter-service.ts`,
`engine/evm-token-risk.ts`, viem + Uniswap SDKs).

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
| Universal Router | `0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99` |
| SwapRouter02 | `0xCaf681a66D020601342297493863E78C959E5cb2` |
| Multicall3 | `0xcA11bDe05977b3631167028862bE2a173976CA11` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

viem does not ship a built-in chain for 4663 — it is defined with
`defineChain({ id: 4663, ... })` in `engine/adapter-service.ts`.
`@uniswap/v3-sdk` + `@uniswap/v4-sdk` + `@uniswap/sdk-core` + `viem` are in
`package.json`.

## Current state

- **Complete EVM port.** All Solana/Meteora-specific execution modules were
  ported to EVM; the Uniswap v3/v4 integration lives in
  `engine/adapter-service.ts` (EVM adapter), `engine/evm-token-risk.ts`
  (honeypot/tax/owner/upgradability probes), and `engine/constants.ts`
  (ETH native, USDG, wei reserves). The engine compiles (`tsc --noEmit` exits
  0) and the full test suite passes (93 files / 1331 tests).
- Renamed: `prism` → `beam` everywhere (env vars `PRISM_*` → `BEAM_*`, config
  dir, CLI binary `beam`, `scripts/beam.sh`, skills, packages).
- `cli/setup.ts` / `ops/setup.ts` prompt for `ROBINHOOD_RPC_URL`.
- Deployment: Cloudflare Workers (`api` + `telegramBot`) + D1 + KV + R2 +
  Vectorize, managed as TypeScript via Alchemy (`cloudflare/infra/alchemy.run.ts`).
  Production site `beam.pryx.dev`. Deploys on merge to main via
  `.github/workflows/deploy-cloudflare.yml`.

## Build / test

```bash
bun install
bun run lint        # tsc --noEmit && oxlint (scripts/lint.sh)
bun run format      # oxfmt --write
bun run test        # vitest (bench/**, Bun required)
```

Cloudflare subproject (separate workspace, own Effect line):

```bash
cd cloudflare && bun install
bun run typecheck   # tsc --noEmit workspaces
bunx vitest run     # worker tests (api, telegram-bot, ...)
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

- Verified chain-fact handoff: `.ulw-notepad.md`
- EVM adapter + decision loop: `engine/adapter-service.ts`, `engine/program.ts`
- Deployment (Alchemy): `cloudflare/infra/alchemy.run.ts`,
  `.github/workflows/deploy-cloudflare.yml`, `docs/alchemy-deploy.md`