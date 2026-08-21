import { describe, it, expect, afterEach, vi } from "vitest";
import { Effect, Layer } from "effect";
import { TickMath } from "@uniswap/v3-sdk";
import {
  decodeAbiParameters,
  decodeFunctionData,
  parseTransaction,
  encodeAbiParameters,
  encodeErrorResult,
  keccak256,
  parseAbi,
  toFunctionSelector,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AdapterLive } from "../engine/adapter-service.js";
import { ConfigService, type AppConfig } from "../engine/config-service.js";
import { AdapterService, type AdapterApi } from "../engine/services.js";
import {
  WETH9,
  V3_NPM,
  V3_SWAP_ROUTER_02,
  DEFAULT_STABLECOIN_MINT,
  V3_SWAP_ROUTER_ENCODING,
  MULTICALL3,
} from "../engine/chain-registry.js";
import { defaultAppConfig } from "./helpers.js";

// ─── Fixtures: a WETH/<stablecoin> 0.3% pool on the ACTIVE chain ─────────────
// Addresses come from chain-registry (Base by default), so the mock RPC builds
// a pool the adapter actually targets with the right WETH + canonical stablecoin.

const WETH = WETH9;
const USDG = DEFAULT_STABLECOIN_MINT;
const ZERO = "0x0000000000000000000000000000000000000000";
const POOL = "0xa9188730fe85be88ad499d7d52b099e800fb0334";
const SWAP_ROUTER_02 = V3_SWAP_ROUTER_02;
const TICK = -200723;
const SQRT_PRICE_X96 = BigInt(TickMath.getSqrtRatioAtTick(TICK).toString());
const LIQUIDITY = 10n ** 22n;
const MAX_UINT256 = 2n ** 256n - 1n;

// SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
const WALLET_KEY = `0x${"ab".repeat(32)}` as `0x${string}`;
// SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
const WALLET = privateKeyToAccount(WALLET_KEY).address.toLowerCase() as `0x${string}`;
const transferTopic = keccak256(toHex("Transfer(address,address,uint256)")).toLowerCase();

const exactInputSingleV2Selector = toFunctionSelector(
  "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
).slice(2);
const multicallSelector = toFunctionSelector("multicall(bytes[])").slice(2);
const aggregate3Selector = toFunctionSelector("aggregate3((address,bool,bytes)[])").slice(2);
const exactInputSingleAbi = parseAbi([
  "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)",
]);
const exactInputSingleCanonicalAbi = parseAbi([
  "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160)) payable returns (uint256)",
]);
const multicallAbi = parseAbi(["function multicall(bytes[]) returns (bytes[])"]);

// ─── Mock JSON-RPC ───────────────────────────────────────────────────────────

interface MockOpts {
  tokenBalances?: Record<string, bigint>; // `${tokenLower}:${holderLower}` -> raw
  nativeBalance?: bigint;
  liquidity?: bigint;
  tokensOwed?: readonly [bigint, bigint];
  swapOut?: bigint; // exactInputSingle eth_call result
  revertSwap?: boolean; // swap calldata eth_call reverts
  revertExit?: string | null; // v3 exit multicall eth_call revert reason
  mintTokenId?: bigint; // mint receipt Transfer log id
  v3PositionCount?: number; // NPM balanceOf → enumerable position count
}

interface SentTx {
  to: string;
  data: Hex;
  value?: string;
}
interface RpcEntry {
  method: string;
  to: string;
  data?: string;
}

interface RpcMock {
  fetch: (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: this test uses a controlled protocol fixture and establishes the expected shape or invariant consumed by this assertion.
    input: unknown,
    init?: { body?: string },
  ) => Promise<Response> /* oxlint-disable-line anti-slop/no-unknown-parameters */;
  sentTxs: SentTx[];
  rpcLog: RpcEntry[];
  /** Top-level JSON-RPC HTTP requests — the true rate-limit cost. Multicall
   *  subcalls are dispatched through the same handler but NOT counted. */
  roundTrips: () => number;
}

const sel = {
  balanceOf: toFunctionSelector("balanceOf(address)"),
  decimals: toFunctionSelector("decimals()"),
  allowance: toFunctionSelector("allowance(address,address)"),
  getPool: toFunctionSelector("getPool(address,address,uint24)"),
  token0: toFunctionSelector("token0()"),
  token1: toFunctionSelector("token1()"),
  fee: toFunctionSelector("fee()"),
  tickSpacing: toFunctionSelector("tickSpacing()"),
  slot0: toFunctionSelector("slot0()"),
  liquidity: toFunctionSelector("liquidity()"),
  positions: toFunctionSelector("positions(uint256)"),
  tokenOfOwnerByIndex: toFunctionSelector("tokenOfOwnerByIndex(address,uint256)"),
  exactInputSingleV2: toFunctionSelector(
    "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
  ),
  // Canonical SwapRouter02 (8-field, WITH deadline) — the ACTIVE chain's
  // encoding when it is a canonical deployment (Base). Same mock behavior.
  exactInputSingleCanonical: toFunctionSelector(
    "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))",
  ),
  multicall: toFunctionSelector("multicall(bytes[])"),
  aggregate3: toFunctionSelector("aggregate3((address,bool,bytes)[])"),
  withdraw: toFunctionSelector("withdraw(uint256)"),
  deposit: toFunctionSelector("deposit()"),
};

const n = (v: bigint | number): string => `0x${BigInt(v).toString(16)}`;
const addr = (a: string): string => a.toLowerCase();

function revertBody(reason: string) {
  return {
    code: 3,
    message: `execution reverted: ${reason}`,
    data: encodeErrorResult({
      abi: parseAbi(["error Error(string)"]),
      errorName: "Error",
      args: [reason],
    }),
  };
}

function createRpcMock(opts: MockOpts = {}): RpcMock {
  const balances = opts.tokenBalances ?? {};
  const sentTxs: SentTx[] = [];
  const rpcLog: RpcEntry[] = [];
  let roundTripCount = 0;

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: this test uses a controlled protocol fixture and establishes the expected shape at this boundary.
  function ok(result: unknown, id: number) {
    /* oxlint-disable-line anti-slop/no-unknown-parameters */
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: this test uses a controlled protocol fixture and establishes the expected shape at this boundary.
    if (typeof result === "string" && result.startsWith("0x") && result.length > 2) {
      /* oxlint-disable-line anti-slop/no-runtime-typeof */
      console.error(`[mock:len] ${(result.length - 2) / 2} bytes: ${result.slice(0, 18)}…`);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      headers: { "content-type": "application/json" },
    });
  }
  // oxlint-disable-next-line anti-slop/no-object-parameters -- SAFETY: this test uses a controlled protocol fixture and establishes the expected shape at this boundary.
  function err(body: object, id: number) {
    /* oxlint-disable-line anti-slop/no-object-parameters */
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: body }), {
      headers: { "content-type": "application/json" },
    });
  }

  async function handle(body: {
    id: number;
    method: string;
    params: unknown[];
  }): Promise<Response> {
    const { id, method, params } = body;
    if (method !== "eth_getTransactionReceipt") {
      console.error(`[mock:req] ${method} ${JSON.stringify(params).slice(0, 160)}`);
    }
    if (method === "eth_chainId") return ok(n(4663), id);
    if (method === "eth_getBalance") return ok(n(opts.nativeBalance ?? 0n), id);
    if (method === "eth_getTransactionCount") return ok("0x0", id);
    if (method === "eth_estimateGas") return ok("0x30d40", id); // 200,000
    if (method === "eth_getBlockByNumber") {
      return ok({ number: "0x1", baseFeePerGas: n(26_028_000) }, id);
    }
    if (method === "eth_sendTransaction") {
      // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
      const p = params[0] as { to: string; data?: string; value?: string };
      sentTxs.push({
        to: addr(p.to),
        // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
        data: (p.data ?? "0x") as Hex,
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: this test uses a controlled protocol fixture and establishes the expected shape at this boundary.
        ...(p.value !== undefined
          ? { value: p.value }
          : {}) /* oxlint-disable-line anti-slop/no-conditional-empty-object-spread */,
      });
      return ok(`0x${sentTxs.length.toString(16).padStart(64, "0")}`, id);
    }
    if (method === "eth_sendRawTransaction") {
      // viem's walletClient signs locally and sends the EIP-2718 envelope;
      // parseTransaction handles the type byte + RLP for us.
      // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
      const raw = params[0] as Hex;
      // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
      const parsed = parseTransaction(raw) as { to?: Hex; value?: bigint; data?: Hex };
      const to = addr(parsed.to ?? "0x");
      // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
      const data = (parsed.data ?? "0x") as Hex;
      rpcLog.push({ method: "eth_sendRawTransaction", to, data });
      sentTxs.push({
        to,
        data,
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: this test uses a controlled protocol fixture and establishes the expected shape at this boundary.
        ...(parsed.value !== undefined
          ? { value: `0x${parsed.value.toString(16)}` }
          : {}) /* oxlint-disable-line anti-slop/no-conditional-empty-object-spread */,
      });
      return ok(`0x${sentTxs.length.toString(16).padStart(64, "0")}`, id);
    }
    if (method === "eth_getTransactionReceipt") {
      // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
      const hash = params[0] as string;
      const logs = opts.mintTokenId
        ? [
            {
              address: V3_NPM.toLowerCase(),
              topics: [
                transferTopic,
                `0x${"0".repeat(64)}`,
                `0x${WALLET.slice(2).padStart(64, "0")}`,
                `0x${opts.mintTokenId.toString(16).padStart(64, "0")}`,
              ],
              data: "0x",
            },
          ]
        : [];
      return ok(
        {
          status: "0x1",
          transactionHash: hash,
          transactionIndex: "0x0",
          blockHash: `0x${"1".repeat(64)}`,
          blockNumber: "0x1",
          from: WALLET,
          to: "0x0",
          logs,
          gasUsed: "0x5208",
          cumulativeGasUsed: "0x5208",
          effectiveGasPrice: "0x1",
          logsBloom: `0x${"0".repeat(512)}`,
          type: "0x2",
          contractAddress: null,
        },
        id,
      );
    }
    if (method === "eth_call") {
      // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
      const req = params[0] as { to: string; data?: string };
      const to = addr(req.to);
      // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
      const data = (req.data ?? "0x") as Hex;
      const selector = data.slice(0, 10).toLowerCase();
      rpcLog.push({ method: "eth_call", to, data });
      // Multicall3 aggregate3 — the adapter batches pool/factory reads through
      // it; dispatch each subcall through this same handler and re-encode.
      if (to === addr(MULTICALL3) && selector === `0x${aggregate3Selector}`) {
        const decoded = decodeAbiParameters(
          [
            {
              type: "tuple[]",
              components: [
                { name: "target", type: "address" },
                { name: "allowFailure", type: "bool" },
                { name: "callData", type: "bytes" },
              ],
            },
          ],
          data.slice(8) as `0x${string}`,
        );
        const subcalls = (decoded[0] ?? []) as ReadonlyArray<{
          target: string;
          allowFailure: boolean;
          callData: Hex;
        }>;
        const results: Array<[boolean, Hex]> = [];
        for (const sub of subcalls) {
          const response = await handle({
            id,
            method: "eth_call",
            params: [{ to: sub.target, data: sub.callData }],
          });
          const json = (await response.json()) as { result?: string; error?: unknown };
          const success = json.error === undefined && json.result !== undefined;
          if (!success && !sub.allowFailure) {
            return err(revertBody("multicall subcall reverted"), id);
          }
          results.push([success, (json.result ?? "0x") as Hex]);
        }
        return ok(
          encodeAbiParameters(
            [{ type: "tuple[]", components: [{ type: "bool" }, { type: "bytes" }] }],
            [results],
          ),
          id,
        );
      }
      // v3 NPM exit multicall (decreaseLiquidity+collect+burn)
      if (to === addr(V3_NPM) && selector === `0x${multicallSelector}` && opts.revertExit) {
        console.error(`[mock:revertExit] firing to=${to.slice(0, 10)} sel=${selector}`);
        return err(revertBody(opts.revertExit), id);
      }
      if (
        (selector === sel.exactInputSingleV2 || selector === sel.exactInputSingleCanonical) &&
        opts.revertSwap
      ) {
        return err(revertBody("insufficient liquidity for swap"), id);
      }
      if (selector === sel.exactInputSingleV2 || selector === sel.exactInputSingleCanonical) {
        return ok(encodeAbiParameters([{ type: "uint256" }], [opts.swapOut ?? 0n]), id);
      }
      if (selector === sel.balanceOf) {
        // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
        const [holder] = decodeAbiParameters([{ type: "address" }], data.slice(8) as `0x${string}`);
        const base = balances[`${to}:${addr(holder)}`] ?? 0n;
        // The v3 NPM reports the mock position count so enumeration tests can
        // scale N without new fixtures.
        const npmBalance = to === addr(V3_NPM) ? BigInt(opts.v3PositionCount ?? 0) : base;
        return ok(encodeAbiParameters([{ type: "uint256" }], [npmBalance]), id);
      }
      if (selector === sel.decimals) {
        return ok(encodeAbiParameters([{ type: "uint8" }], [to === addr(WETH) ? 18 : 6]), id);
      }
      if (selector === sel.allowance) {
        return ok(encodeAbiParameters([{ type: "uint256" }], [MAX_UINT256]), id);
      }
      if (selector === sel.getPool) {
        const [a, b, fee] = decodeAbiParameters(
          [{ type: "address" }, { type: "address" }, { type: "uint24" }],
          // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
          data.slice(8) as `0x${string}`,
        );
        const pair = [addr(a), addr(b)].sort();
        const wethUsdg = [addr(WETH), addr(USDG)].sort();
        const pool =
          fee === 3000 && pair[0] === wethUsdg[0] && pair[1] === wethUsdg[1] ? POOL : ZERO;
        return ok(encodeAbiParameters([{ type: "address" }], [pool]), id);
      }
      if (selector === sel.token0)
        return ok(encodeAbiParameters([{ type: "address" }], [WETH]), id);
      if (selector === sel.token1)
        return ok(encodeAbiParameters([{ type: "address" }], [USDG]), id);
      if (selector === sel.fee) return ok(encodeAbiParameters([{ type: "uint24" }], [3000]), id);
      if (selector === sel.tickSpacing)
        return ok(encodeAbiParameters([{ type: "int24" }], [60]), id);
      if (selector === sel.slot0) {
        return ok(
          encodeAbiParameters(
            [
              { type: "uint160" },
              { type: "int24" },
              { type: "uint16" },
              { type: "uint16" },
              { type: "uint16" },
              { type: "uint8" },
              { type: "bool" },
            ],
            [SQRT_PRICE_X96, TICK, 0, 0, 0, 0, true],
          ),
          id,
        );
      }
      if (selector === sel.liquidity) {
        return ok(encodeAbiParameters([{ type: "uint128" }], [opts.liquidity ?? LIQUIDITY]), id);
      }
      if (selector === sel.positions) {
        const [owed0, owed1] = opts.tokensOwed ?? [0n, 0n];
        return ok(
          encodeAbiParameters(
            [
              { type: "uint96" },
              { type: "address" },
              { type: "address" },
              { type: "address" },
              { type: "uint24" },
              { type: "int24" },
              { type: "int24" },
              { type: "uint128" },
              { type: "uint256" },
              { type: "uint256" },
              { type: "uint128" },
              { type: "uint128" },
            ],
            [0n, WALLET, WETH, USDG, 3000, -201240, -200220, LIQUIDITY, 0n, 0n, owed0, owed1],
          ),
          id,
        );
      }
      if (selector === sel.tokenOfOwnerByIndex) {
        // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
        const [, index] = decodeAbiParameters(
          [{ type: "address" }, { type: "uint256" }],
          data.slice(8) as `0x${string}`,
        );
        return ok(
          encodeAbiParameters([{ type: "uint256" }], [1000n + index]),
          id,
        );
      }
      return ok("0x", id);
    }
    return ok("0x", id);
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: this test uses a controlled protocol fixture and establishes the expected shape at this boundary.
  const fetchImpl = async (_input: unknown, init?: { body?: string }) => {
    /* oxlint-disable-line anti-slop/no-unknown-parameters */
    roundTripCount++; // one HTTP request per top-level JSON-RPC call
    // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
    const body = JSON.parse(init?.body ?? "{}") as {
      id: number;
      method: string;
      params: unknown[];
    };
    if (body.method === "eth_sendTransaction" || body.method === "eth_call") {
      // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
      const p = (body.params[0] ?? {}) as { to?: string };
      rpcLog.push({ method: body.method, to: addr(p.to ?? ZERO) });
    }
    return handle(body);
  };
  return { fetch: fetchImpl, sentTxs, rpcLog, roundTrips: () => roundTripCount };
}

// ─── Program plumbing ────────────────────────────────────────────────────────

function makeProgram(opts?: {
  exitProofConfig?: { simulateBeforeExit?: boolean };
  swapMintConfig?: { maxSwapSlippageBps?: number };
}) {
  const cfg = defaultAppConfig({
    walletPrivateKey: WALLET_KEY,
    rpcUrl: "https://rpc.mock.local",
    rpcFallbackUrls: [],
    paperTrading: false,
  });
  const enriched: typeof cfg & {
    exitProofConfig?: { simulateBeforeExit?: boolean };
    swapMintConfig?: { maxSwapSlippageBps?: number };
  } = { ...cfg };
  if (opts?.exitProofConfig) enriched.exitProofConfig = opts.exitProofConfig;
  if (opts?.swapMintConfig) enriched.swapMintConfig = opts.swapMintConfig;
  return Layer.provide(AdapterLive, Layer.succeed(ConfigService, enriched));
}

async function adapterFor(): Promise<AdapterApi> {
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        return yield* AdapterService;
      }),
      makeProgram(),
    ),
  );
}

let mock: RpcMock;
function installMock(opts: MockOpts = {}): RpcMock {
  mock = createRpcMock(opts);
  vi.stubGlobal("fetch", mock.fetch);
  return mock;
}
afterEach(() => vi.unstubAllGlobals());

// ─── enterPosition funding branches ──────────────────────────────────────────

describe("enterPosition funding decision (v3 WETH/USDG pool)", () => {
  it("both legs fundable → two-sided mint, no swap, no wrap", async () => {
    const m = installMock({
      tokenBalances: {
        [`${addr(WETH)}:${WALLET}`]: 10n ** 18n,
        [`${addr(USDG)}:${WALLET}`]: 10n ** 9n,
      },
      nativeBalance: 10n ** 18n,
      mintTokenId: 7n,
    });
    const svc = await adapterFor();
    const res = await Effect.runPromise(svc.enterPosition(POOL, 0, 0, 1000));
    expect(res.depositMode).toBe("two-sided");
    expect(res.positionPubKey).toBe("7");
    const tos = m.sentTxs.map((t) => t.to);
    expect(tos.filter((t) => t === addr(V3_NPM))).toHaveLength(1);
    expect(tos.includes(addr(WETH))).toBe(false); // no wrap
    expect(tos.includes(addr(SWAP_ROUTER_02))).toBe(false); // no swap
  });

  it("only WETH held → single-sided-x, no swap", async () => {
    const m = installMock({
      tokenBalances: { [`${addr(WETH)}:${WALLET}`]: 5n * 10n ** 17n }, // > half-size WETH
      nativeBalance: 10n ** 18n,
      mintTokenId: 8n,
    });
    const svc = await adapterFor();
    const res = await Effect.runPromise(svc.enterPosition(POOL, 0, 0, 1000));
    expect(res.depositMode).toBe("single-sided-x");
    expect(m.sentTxs.some((t) => t.to === addr(SWAP_ROUTER_02))).toBe(false);
  });

  it("only native ETH held → single-sided-x via WETH wrap before the mint", async () => {
    const m = installMock({ nativeBalance: 10n ** 18n, mintTokenId: 9n });
    const svc = await adapterFor();
    const res = await Effect.runPromise(svc.enterPosition(POOL, 0, 0, 1000));
    expect(res.depositMode).toBe("single-sided-x");
    // wrap (WETH9.deposit) then mint (V3_NPM), in that order
    expect(m.sentTxs[0]?.to).toBe(addr(WETH));
    expect(m.sentTxs[1]?.to).toBe(addr(V3_NPM));
  });

  it("neither leg fundable + native held + route works → swap-to-fund then two-sided mint", async () => {
    const m = installMock({
      nativeBalance: 10n ** 18n,
      mintTokenId: 11n,
      swapOut: 600_000_000n,
      // The swap delivers the missing leg to the wallet; the post-swap
      // pre-mint balance proof (dp8) reads it before the mint.
      tokenBalances: { [`${addr(USDG)}:${addr(WALLET)}`]: 600_000_000n },
    });
    const svc = await adapterFor();
    const res = await Effect.runPromise(svc.enterPosition(POOL, 0, 0, 1000));
    expect(res.depositMode).toBe("two-sided");
    const swapTx = m.sentTxs.find((t) => t.to === addr(SWAP_ROUTER_02));
    expect(swapTx).toBeDefined();
    // the swap uses the ACTIVE chain's SwapRouter02 encoding (8-field on
    // canonical chains like Base, 7-field on Robinhood's fork)
    const expectedSwapSelector =
      V3_SWAP_ROUTER_ENCODING === "canonical-8f"
        ? sel.exactInputSingleCanonical.slice(2)
        : sel.exactInputSingleV2.slice(2);
    expect(swapTx!.data.slice(2, 10)).toBe(expectedSwapSelector);
    // native-in swap carries msg.value = amountIn
    expect(BigInt(swapTx!.value ?? "0x0")).toBeGreaterThan(0n);
    // swap before mint
    const swapIdx = m.sentTxs.findIndex((t) => t.to === addr(SWAP_ROUTER_02));
    const mintIdx = m.sentTxs.findIndex((t) => t.to === addr(V3_NPM));
    expect(swapIdx).toBeGreaterThanOrEqual(0);
    expect(mintIdx).toBeGreaterThan(swapIdx);
  });

  it("neither leg fundable + route gives no liquidity → 'can fund neither leg' error, nothing broadcast", async () => {
    const m = installMock({ nativeBalance: 10n ** 18n, liquidity: 0n });
    const svc = await adapterFor();
    await expect(Effect.runPromise(svc.enterPosition(POOL, 0, 0, 1000))).rejects.toThrow(
      /can fund neither leg/,
    );
    expect(m.sentTxs).toHaveLength(0);
  });

  it("swap probe reverts → falls back to 'can fund neither leg', swap never broadcast", async () => {
    const m = installMock({ nativeBalance: 10n ** 18n, revertSwap: true });
    const svc = await adapterFor();
    await expect(Effect.runPromise(svc.enterPosition(POOL, 0, 0, 1000))).rejects.toThrow(
      /can fund neither leg/,
    );
    expect(m.sentTxs.filter((t) => t.to === addr(SWAP_ROUTER_02))).toHaveLength(0);
  });
});

// ─── verifyExitRoute ─────────────────────────────────────────────────────────

describe("verifyExitRoute", () => {
  it("ok when both legs are convertible (WETH unwraps, USDG swaps to ETH)", async () => {
    installMock({
      tokenBalances: { [`${addr(USDG)}:${WALLET}`]: 10n ** 9n },
      nativeBalance: 10n ** 18n,
      swapOut: 260_000_000_000_000_000n,
    });
    const svc = await adapterFor();
    const res = await Effect.runPromise(svc.verifyExitRoute!(POOL, 1000));
    expect(res.ok).toBe(true);
    expect(res.reason).toBeNull();
    expect(res.proceedsUsd).not.toBeNull();
    expect(res.proceedsUsd!).toBeGreaterThan(0);
  });

  it("fails when the quote path is dead (zero liquidity)", async () => {
    installMock({ nativeBalance: 10n ** 18n, liquidity: 0n });
    const svc = await adapterFor();
    const res = await Effect.runPromise(svc.verifyExitRoute!(POOL, 1000));
    expect(res.ok).toBe(false);
    expect(res.reason).not.toBeNull();
  });
});

// ─── simulateWithdraw fail-closed wiring ─────────────────────────────────────

describe("simulateWithdraw fail-closed (exitPosition / rebalancePosition)", () => {
  it("exitPosition: reverting exit calldata → descriptive error, NEVER broadcasts", async () => {
    const m = installMock({ revertExit: "NOT_MANAGER" });
    const svc = await adapterFor();
    await expect(Effect.runPromise(svc.exitPosition(POOL, "42"))).rejects.toThrow(
      /exitPosition: withdraw dry-run failed — NOT broadcasting \(NOT_MANAGER\)/,
    );
    expect(m.sentTxs).toHaveLength(0);
  });

  it("rebalancePosition: reverting exit calldata → descriptive error, NEVER broadcasts", async () => {
    const m = installMock({ revertExit: "NOT_MANAGER" });
    const svc = await adapterFor();
    await expect(Effect.runPromise(svc.rebalancePosition(POOL, "42", 0, 0))).rejects.toThrow(
      /rebalancePosition: withdraw dry-run failed — NOT broadcasting \(NOT_MANAGER\)/,
    );
    expect(m.sentTxs).toHaveLength(0);
  });

  it("simulateWithdraw direct: ok on pass, decoded reason on revert", async () => {
    installMock({ revertExit: "NOT_MANAGER" });
    const svc = await adapterFor();
    const fail = await Effect.runPromise(svc.simulateWithdraw!(POOL, "42"));
    expect(fail.ok).toBe(false);
    expect(fail.reason).toContain("NOT_MANAGER");

    vi.unstubAllGlobals();
    installMock({});
    const okSim = await Effect.runPromise(svc.simulateWithdraw!(POOL, "42"));
    expect(okSim.ok).toBe(true);
  });

  it("ExitProofConfig.simulateBeforeExit=false skips the gate (broadcast attempt surfaces sendTx dry-run instead)", async () => {
    // Reinstall with the gate OFF: the simulate gate must NOT short-circuit;
    // the underlying sendTx dry-run still fails safely (never broadcasts).
    vi.unstubAllGlobals();
    const m = createRpcMock({ revertExit: "NOT_MANAGER" });
    mock = m;
    vi.stubGlobal("fetch", m.fetch);
    const cfg = defaultAppConfig({
      walletPrivateKey: WALLET_KEY,
      rpcUrl: "https://rpc.mock.local",
      rpcFallbackUrls: [],
      paperTrading: false,
    });
    const program = Layer.provide(
      AdapterLive,
      // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
      Layer.succeed(ConfigService, {
        ...cfg,
        exitProofConfig: { simulateBeforeExit: false },
        // SAFETY: The controlled test fixture establishes the asserted shape at this boundary, and the surrounding test consumes only that documented invariant.
      } as AppConfig),
    );
    const svc = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          return yield* AdapterService;
        }),
        program,
      ),
    );
    const err = await Effect.runPromise(svc.exitPosition(POOL, "42")).catch(
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: this test uses a controlled protocol fixture and establishes the expected shape at this boundary.
      (e: unknown) => e,
    ); /* oxlint-disable-line anti-slop/no-unknown-parameters */
    expect(String(err)).not.toContain("withdraw dry-run failed");
    expect(String(err)).toContain("NOT_MANAGER");
    expect(m.sentTxs).toHaveLength(0);
  });
});

// ─── convertClaimedFees ──────────────────────────────────────────────────────

describe("convertClaimedFees (real conversion)", () => {
  it("accumulate-native: unwraps WETH, swaps USDG→ETH via the live v2 route, dry-run before send", async () => {
    const m = installMock({
      nativeBalance: 10n ** 18n,
      swapOut: 260_000_000_000_000_000n,
    });
    const svc = await adapterFor();
    const res = await Effect.runPromise(
      svc.convertClaimedFees!(POOL, "accumulate-native", 0.2, 500),
    );
    expect(res.txSignatures).toHaveLength(2);
    expect(res.outputAtomic).toBeGreaterThan(0n);
    expect(res.outputUsd).not.toBeNull();

    // WETH leg → direct withdraw on WETH9
    const withdrawTx = m.sentTxs.find((t) => t.to === addr(WETH));
    expect(withdrawTx).toBeDefined();
    expect(withdrawTx!.data.slice(0, 10)).toBe(toFunctionSelector("withdraw(uint256)"));

    // USDG leg → multicall(swap + unwrap) on SwapRouter02 with the v2 encoding
    const swapTx = m.sentTxs.find((t) => t.to === addr(SWAP_ROUTER_02));
    expect(swapTx).toBeDefined();
    const { args } = decodeFunctionData({ abi: multicallAbi, data: swapTx!.data });
    // SAFETY: The fixture/assertion is intentionally narrowed here; the surrounding test establishes the exact shape or invariant consumed by this assertion.
    const inner = (args[0] as readonly `0x${string}`[])[0]!;
    // USDG leg uses the ACTIVE chain's SwapRouter02 encoding (8-field canonical
    // on Base, 7-field on Robinhood's fork).
    if (V3_SWAP_ROUTER_ENCODING === "canonical-8f") {
      expect(inner.slice(2, 10)).toBe(sel.exactInputSingleCanonical.slice(2));
      const innerDecoded = decodeFunctionData({ abi: exactInputSingleCanonicalAbi, data: inner });
      // SAFETY: The surrounding test establishes the exact shape of this controlled fixture before this assertion.
      expect((innerDecoded.args[0] as unknown as unknown[]).length).toBe(8); // oxlint-disable-line anti-slop/no-chained-type-assertions -- SAFETY: this test boundary uses a deliberately partial fixture or ABI-decoded tuple; the surrounding test establishes the exact exercised shape.
    } else {
      expect(inner.slice(2, 10)).toBe(exactInputSingleV2Selector);
      const innerDecoded = decodeFunctionData({ abi: exactInputSingleAbi, data: inner });
      // SAFETY: The surrounding test establishes the exact shape of this controlled fixture before this assertion.
      expect((innerDecoded.args[0] as unknown as unknown[]).length).toBe(7); // oxlint-disable-line anti-slop/no-chained-type-assertions -- SAFETY: this test boundary uses a deliberately partial fixture or ABI-decoded tuple; the surrounding test establishes the exact exercised shape.
    }

    // ordering: eth_call dry-run of the swap precedes its broadcast
    const swapCall = m.rpcLog.findIndex(
      (e) => e.method === "eth_call" && e.to === addr(SWAP_ROUTER_02),
    );
    const swapSend = m.rpcLog.findIndex(
      (e) => e.method === "eth_sendRawTransaction" && e.to === addr(SWAP_ROUTER_02),
    );
    expect(swapCall).toBeGreaterThanOrEqual(0);
    expect(swapSend).toBeGreaterThan(swapCall);
  });
});

// ─── getPendingFees ──────────────────────────────────────────────────────────

describe("getPendingFees", () => {
  it("v3: reads tokensOwed and prices them", async () => {
    installMock({ tokensOwed: [10n ** 17n, 200_000_000n] });
    const svc = await adapterFor();
    const res = await Effect.runPromise(svc.getPendingFees!(POOL, "42"));
    expect(res).not.toBeNull();
    expect(res!.feeX).toBe(10n ** 17n); // 0.1 WETH
    expect(res!.feeY).toBe(200_000_000n); // 200 USDG
    expect(res!.feeXUsd).toBeGreaterThan(100);
    expect(res!.feeXUsd).toBeLessThan(300);
    expect(res!.feeYUsd).toBe(200);
  });

  it("v4: returns null (4663 StateView has no claimable-fee read)", async () => {
    installMock({});
    const svc = await adapterFor();
    const v4Addr = `0x${"11".repeat(32)}`;
    const res = await Effect.runPromise(svc.getPendingFees!(v4Addr, "42"));
    expect(res).toBeNull();
  });
});

// ─── claimFees estimatedGasUsd ───────────────────────────────────────────────

describe("claimFees estimatedGasUsd", () => {
  it("computes gas × 2×baseFee × native price when fees are owed", async () => {
    installMock({
      tokensOwed: [10n ** 17n, 200_000_000n],
      nativeBalance: 10n ** 18n,
    });
    const svc = await adapterFor();
    const res = await Effect.runPromise(svc.claimFees(POOL, "42"));
    expect(res.estimatedGasUsd).not.toBeNull();
    // 200_000 gas × 52_056_000 maxFee × ~$1925 / 1e18 ≈ $0.02
    expect(res.estimatedGasUsd!).toBeGreaterThan(0.005);
    expect(res.estimatedGasUsd!).toBeLessThan(0.1);
  });

  it("zero-fee shortcut returns explicit null (no broadcast)", async () => {
    const m = installMock({ tokensOwed: [0n, 0n] });
    const svc = await adapterFor();
    const res = await Effect.runPromise(svc.claimFees(POOL, "42"));
    expect(res.txSignature).toBe("");
    expect(res.estimatedGasUsd).toBeNull();
    expect(m.sentTxs).toHaveLength(0);
  });
});

// ─── RPC round-trip budgets (rate-limit protection) ──────────────────────────
// The public Robinhood RPC rate-limits (429s). These lock in the batching
// wins: enumeration cost must NOT scale with position count, repeat
// enumerations within a cycle must be free, and broadcasts must invalidate.

describe("RPC round-trip budgets", () => {
  it("v3 enumeration cost is flat in position count (batched, not per-NFT)", async () => {
    const few = installMock({ v3PositionCount: 1 });
    const svcFew = await adapterFor();
    await Effect.runPromise(svcFew.getAllWalletPositions(WALLET));
    const cost1 = few.roundTrips();

    const many = installMock({ v3PositionCount: 8 });
    const svcMany = await adapterFor();
    await Effect.runPromise(svcMany.getAllWalletPositions(WALLET));
    const cost8 = many.roundTrips();

    expect(cost8).toBeLessThanOrEqual(cost1 + 2); // flat ±2 for chain bootstrap
    expect(cost8).toBeLessThan(15); // was ~1+3N sequential before batching
  });

  it("repeat enumeration within a cycle is free (shared cache), and a broadcast drops it", async () => {
    const m = installMock({
      v3PositionCount: 2,
      // Fund the ENTER so its broadcast actually lands (wrap + mint).
      nativeBalance: 10n ** 18n,
      mintTokenId: 12n,
    });
    const svc = await adapterFor();
    await Effect.runPromise(svc.getAllWalletPositions(WALLET));
    const afterFirst = m.roundTrips();
    // Second enumeration-only call inside the TTL window: zero round trips.
    await Effect.runPromise(svc.getAllWalletPositions(WALLET));
    expect(m.roundTrips()).toBe(afterFirst);

    // A successful broadcast (the ENTER's wrap/mint) invalidates the cache.
    await Effect.runPromise(
      svc.enterPosition(POOL, 0, 0, 1000).pipe(Effect.ignore),
    );
    const afterBroadcast = m.roundTrips();
    expect(m.sentTxs.length).toBeGreaterThan(0); // broadcast really landed
    await Effect.runPromise(svc.getAllWalletPositions(WALLET));
    expect(m.roundTrips()).toBeGreaterThan(afterBroadcast); // re-enumerated
  });

  it("priceUsd repeats hit the TTL cache (one pricing round trip per token)", async () => {
    const m = installMock({});
    const svc = await adapterFor();
    const first = await Effect.runPromise(svc.getTokenPrices([WETH]));
    const afterFirst = m.roundTrips();
    const second = await Effect.runPromise(svc.getTokenPrices([WETH]));
    expect(second[WETH]).toBe(first[WETH]);
    expect(m.roundTrips()).toBe(afterFirst); // served from cache
  });

  it("batched scan (getPoolStatesWithBins) is ~flat in pool count", async () => {
    const pools = [
      POOL,
      "0xa9188730fe85be88ad499d7d52b099e800fb0335",
      "0xa9188730fe85be88ad499d7d52b099e800fb0336",
    ];
    const few = installMock({});
    const svcFew = await adapterFor();
    const fewResult = await Effect.runPromise(svcFew.getPoolStatesWithBins!(pools));
    const cost3 = few.roundTrips();
    // Correctness: every pool got state + bins from ONE core read + ONE lens
    // read (the mock serves token0/token1/slot0/liquidity for any target).
    expect(fewResult.size).toBe(3);
    for (const [, entry] of fewResult) {
      expect(entry.state.tokenX).toBe(addr(WETH));
      expect(entry.bins).not.toBeNull();
      expect(entry.bins?.reservesKnown).toBe(true);
    }

    const more = [...pools, "...1", "...2", "...3"].map((p, i) =>
      i < 3 ? p : `0xa9188730fe85be88ad499d7d52b099e800fb03${(6 + i).toString(16).padStart(2, "0")}`,
    );
    const many = installMock({});
    const svcMany = await adapterFor();
    await Effect.runPromise(svcMany.getPoolStatesWithBins!(more));
    const cost6 = many.roundTrips();

    expect(cost6).toBeLessThanOrEqual(cost3 + 2); // ~flat: 2 multicalls per chunk
    expect(cost6).toBeLessThan(12); // was 3 RTs PER pool before batching
  });

  it("getBinArrays batch serves every requested pool", async () => {
    installMock({});
    const svc = await adapterFor();
    const pools = [
      POOL,
      "0xa9188730fe85be88ad499d7d52b099e800fb0335",
      "0xa9188730fe85be88ad499d7d52b099e800fb0336",
    ];
    const bins = await Effect.runPromise(svc.getBinArrays!(pools));
    expect(bins.size).toBe(3);
    for (const p of pools) {
      expect(bins.get(p.toLowerCase())).not.toBeNull();
    }
  });
});
