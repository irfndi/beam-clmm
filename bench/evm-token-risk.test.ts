/**
 * Decision-path tests for engine/evm-token-risk.ts with a fully mocked RPC
 * layer (injected fetch). No live chain. The mock faithfully models chain 4663
 * behavior: eth_simulateV1 returns per-call status/logs/returnData, `state`
 * overrides are honored, `stateDiff` is ignored, reverts are JSON-RPC errors
 * (eth_call) / status "0x0" (simulateV1).
 */

import { describe, expect, it } from "vitest";
import { createPublicClient, http, keccak256, numberToHex, type Address, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { computeTaxPct, compositeVerdict, createTokenRiskProber } from "../engine/evm-token-risk.js";

// ─── Test doubles ────────────────────────────────────────────────────────────

const PROBE = "0x0000000000000000000000000000000000000002" as Address;
const POOL = "0x00000000000000000000000000000000000000c0" as Address;
const WETH = "0x00000000000000000000000000000000000000d0" as Address;

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ERC1967_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** Runtime bytecode blobs are never executed by the mock — only scanned for selectors. */
const ERC20_RUNTIME = "0x6080604052348015600f57600080fd5b506370a08231a9059cbb313ce567" as Hex;
const ERC1967_STUB = "0x6080604052366000573d6000fd5b3660006000373660006020376000f3" as Hex;
const IMPL = "0x00000000000000000000000000000000000000aa" as Address;

// Independent storage-key implementations (cross-check the module's keys).
function stdKey(addr: Address, slot: number): Hex {
  return keccak256(`0x${addr.slice(2).toLowerCase()}${numberToHex(BigInt(slot), { size: 32 }).slice(2)}`);
}
function paddedKey(addr: Address, slot: number): Hex {
  return keccak256(`0x${addr.slice(2).toLowerCase().padStart(64, "0")}${numberToHex(BigInt(slot), { size: 32 }).slice(2)}`);
}
function allowanceKeyStd(owner: Address, spender: Address, slot: number): Hex {
  return keccak256(`0x${owner.slice(2).toLowerCase()}${stdKey(spender, slot).slice(2)}`);
}
function allowanceKeyPadded(owner: Address, spender: Address, slot: number): Hex {
  return keccak256(`0x${owner.slice(2).toLowerCase().padStart(64, "0")}${paddedKey(spender, slot).slice(2)}`);
}
function pad(addr: string): string {
  return `0x${"0".repeat(24)}${addr.slice(2).toLowerCase()}`;
}
function toBI(value: string | undefined | null): bigint {
  if (!value || value === "0x" || value === "0x0") return 0n;
  return BigInt(value);
}
function encodeRevert(reason: string): Hex {
  const data = Buffer.from(reason, "utf8").toString("hex");
  const word = (s: string) => s.padStart(64, "0");
  return `0x08c379a0${word("20")}${word(data.length.toString(16))}${data}${"0".repeat((64 - (data.length % 64)) % 64)}`;
}
function revertCall(reason: string): { returnData: Hex; status: "0x0"; logs: SimLog[] } {
  return { returnData: encodeRevert(reason), status: "0x0", logs: [] };
}

interface FakeTokenOpts {
  balanceSlot?: number; // standard-packing balance slot index (default 0)
  paddedLayout?: boolean; // use the padded-address packing instead
  taxBps?: number;
  honeypot?: boolean;
  owner?: Address | null;
  pendingOwner?: Address | null;
  decimals?: number;
  decimalsReverts?: boolean;
  balanceOfReverts?: boolean;
  codeKind?: "erc20" | "erc1967" | "eip1167" | "none";
  implAddress?: Address;
}

interface SimLog {
  address: Address;
  topics: string[];
  data: Hex;
}

class FakeERC20 {
  readonly address: Address;
  readonly opts: FakeTokenOpts;
  readonly storage = new Map<string, Hex>();

  constructor(address: Address, opts: FakeTokenOpts = {}) {
    this.address = address;
    this.opts = opts;
  }

  balanceKey(addr: Address): Hex {
    const slot = this.opts.balanceSlot ?? 0;
    return this.opts.paddedLayout ? paddedKey(addr, slot) : stdKey(addr, slot);
  }

  runtimeCode(): Hex {
    switch (this.opts.codeKind ?? "erc20") {
      case "none":
        return "0x";
      case "erc1967":
        return ERC1967_STUB;
      case "eip1167":
        return `0x363d3d373d3d3d3d363d73${(this.opts.implAddress ?? IMPL).slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3` as Hex;
      default:
        return ERC20_RUNTIME;
    }
  }

  /** Execute one call against `scratch`, returning the logs the call emitted. */
  run(tx: { from?: Address; data: Hex }, scratch: Map<string, Hex>): { returnData: Hex; status: "0x0" | "0x1"; logs: SimLog[] } {
    const data = tx.data ?? "0x";
    const selector = data.slice(0, 10);
    const logs: SimLog[] = [];
    const read = (addr: Address) => toBI(scratch.get(this.balanceKey(addr).toLowerCase()) ?? "0x0");
    const write = (addr: Address, value: bigint) =>
      scratch.set(this.balanceKey(addr).toLowerCase(), numberToHex(value, { size: 32 }));

    switch (selector) {
      case "0x70a08231": {
        if (this.opts.balanceOfReverts) return revertCall("balanceOf reverted");
        const addr = `0x${data.slice(34, 74)}` as Address;
        return { returnData: numberToHex(read(addr), { size: 32 }), status: "0x1", logs };
      }
      case "0xa9059cbb": {
        if (this.opts.honeypot) return revertCall("honeypot");
        const to = `0x${data.slice(34, 74)}` as Address;
        const amount = toBI(`0x${data.slice(74)}`);
        const sender = tx.from ?? "0x0000000000000000000000000000000000000000";
        const balance = read(sender);
        if (balance < amount) return revertCall("insufficient balance");
        const received = (amount * BigInt(10000 - (this.opts.taxBps ?? 0))) / 10000n;
        write(sender, balance - amount);
        write(to, read(to) + received);
        logs.push({
          address: this.address,
          topics: [TRANSFER_TOPIC, pad(sender), pad(to)],
          data: numberToHex(received, { size: 32 }),
        });
        return { returnData: `0x${"0".repeat(63)}1`, status: "0x1", logs };
      }
      case "0x313ce567": {
        if (this.opts.decimalsReverts) return revertCall("decimals reverted");
        return { returnData: numberToHex(BigInt(this.opts.decimals ?? 18), { size: 32 }), status: "0x1", logs };
      }
      case "0x8da5cb5b": {
        if (!this.opts.owner) return revertCall("no owner");
        return { returnData: `0x${"0".repeat(24)}${this.opts.owner.slice(2).toLowerCase()}`, status: "0x1", logs };
      }
      case "0xe30c3978": {
        if (!this.opts.pendingOwner) return revertCall("no pendingOwner");
        return { returnData: `0x${"0".repeat(24)}${this.opts.pendingOwner.slice(2).toLowerCase()}`, status: "0x1", logs };
      }
      default:
        return revertCall(`unknown selector ${selector}`);
    }
  }
}

interface FakePool {
  address: Address;
  mode: "ok" | "revert";
  outAmount: bigint;
  outToken: Address;
  revertReason: string;
}

function applyOverride(token: FakeERC20, override: unknown): Map<string, Hex> {
  const scratch = new Map(token.storage);
  const entry = (override as Record<string, { state?: Record<Hex, Hex>; stateDiff?: Record<Hex, Hex> }> | undefined)?.[
    token.address.toLowerCase()
  ];
  if (entry?.state) {
    scratch.clear();
    for (const [slot, value] of Object.entries(entry.state)) scratch.set(slot.toLowerCase(), value);
  }
  // stateDiff is intentionally ignored — faithful to 4663's observed behavior.
  return scratch;
}

function makeRpcMock(tokens: FakeERC20[], pool?: FakePool) {
  const byAddress = new Map(tokens.map((t) => [t.address.toLowerCase(), t]));
  let rpcCalls = 0;
  const simulateParams: unknown[] = [];

  function tokenCall(tx: { from?: Address; to: Address; data: Hex }, override: unknown) {
    const token = byAddress.get(tx.to.toLowerCase());
    if (!token) return revertCall("unknown target");
    const scratch = applyOverride(token, override);
    return token.run(tx, scratch);
  }

  async function handle(method: string, params: unknown[]): Promise<{ result?: unknown; error?: { code: number; message: string; data?: string } }> {
    rpcCalls += 1;
    switch (method) {
      case "eth_chainId":
        return { result: "0x1" };
      case "eth_getCode": {
        const [addr] = params as [Address];
        const lower = (addr ?? "").toLowerCase();
        const token = byAddress.get(lower);
        if (token) return { result: token.runtimeCode() };
        // Implementation addresses referenced by proxy tokens carry the token
        // runtime (with standard selectors) so sanity can scan them.
        for (const t of tokens) {
          if ((t.opts.codeKind === "erc1967" || t.opts.codeKind === "eip1167") && (t.opts.implAddress ?? IMPL).toLowerCase() === lower) {
            return { result: ERC20_RUNTIME };
          }
        }
        return { result: "0x" };
      }
      case "eth_getStorageAt": {
        const [addr, slot] = params as [Address, Hex];
        const token = byAddress.get((addr ?? "").toLowerCase());
        if (!token) return { result: "0x0" };
        if ((slot ?? "").toLowerCase() === ERC1967_SLOT && (token.opts.codeKind ?? "erc20") === "erc1967") {
          return { result: `0x${"0".repeat(24)}${(token.opts.implAddress ?? IMPL).slice(2).toLowerCase()}` };
        }
        return { result: token.storage.get((slot ?? "").toLowerCase()) ?? "0x0" };
      }
      case "eth_call": {
        const [tx] = params as [{ from?: Address; to: Address; data: Hex }];
        if (!tx) return { error: { code: -32602, message: "invalid eth_call params" } };
        const result = tokenCall(tx, params[2]);
        if (result.status !== "0x1") {
          return { error: { code: 3, message: "execution reverted", data: result.returnData } };
        }
        return { result: result.returnData };
      }
      case "eth_simulateV1": {
        simulateParams.push(params);
        const [param] = params as [
          { blockStateCalls: Array<{ calls: Array<{ from?: Address; to: Address; data: Hex }>; stateOverrides?: unknown }> },
        ];
        if (!param) return { error: { code: -32602, message: "invalid simulateV1 params" } };
        const block = param.blockStateCalls[0];
        if (!block) return { error: { code: -32602, message: "invalid simulateV1 params" } };
        const calls = block.calls ?? [];
        // One scratch per token per block: calls in a block share state, so the
        // transfer mutates the balance read by the following balanceOf call.
        const scratches = new Map<string, Map<string, Hex>>();
        const results = calls.map((tx) => {
          if (pool && tx.to.toLowerCase() === pool.address.toLowerCase()) {
            if (pool.mode === "revert") return revertCall(pool.revertReason);
            const outLog: SimLog = {
              address: pool.outToken,
              topics: [TRANSFER_TOPIC, pad(pool.address), pad(PROBE)],
              data: numberToHex(pool.outAmount, { size: 32 }),
            };
            return { returnData: "0x" as Hex, status: "0x1" as const, logs: [outLog] };
          }
          const token = byAddress.get(tx.to.toLowerCase());
          if (!token) return revertCall("unknown target");
          let scratch = scratches.get(token.address.toLowerCase());
          if (!scratch) {
            scratch = applyOverride(token, block.stateOverrides);
            scratches.set(token.address.toLowerCase(), scratch);
          }
          return token.run(tx, scratch);
        });
        return {
          result: [
            {
              baseFeePerGas: "0x0",
              blobGasUsed: "0x0",
              blockHash: "0x0",
              calls: results,
              logs: results.flatMap((r) => r.logs),
              status: "0x1",
              returnData: "0x",
              storageDiff: [],
              gasUsed: "0x0",
            },
          ],
        };
      }
      default:
        return { error: { code: -32601, message: `method ${method} not supported` } };
    }
  }

  const fetchImpl = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (!body || typeof body.method !== "string") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body?.id ?? 0, error: { code: -32600, message: "invalid request" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const outcome = await handle(body.method, body.params ?? []);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...outcome }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  return { fetchImpl: fetchImpl as unknown as typeof fetch, rpcCalls: () => rpcCalls, simulateParams };
}

function makeClient(fetchImpl: typeof fetch) {
  return createPublicClient({
    chain: mainnet,
    transport: http("http://mock-rpc.local", { fetchFn: fetchImpl, retryCount: 0, timeout: 5000 }),
  });
}

function cleanToken(address: Address = "0x00000000000000000000000000000000000000bb"): FakeERC20 {
  return new FakeERC20(address, {});
}

function assess(
  token: FakeERC20,
  config: { enabled: boolean; maxTransferTaxPct?: number; allowlistedMints?: Set<string> },
  pool?: FakePool,
  options?: { sellRoute: { poolAddress: Address; calldata: Hex; amountIn: bigint; expectedOutToken?: Address } },
) {
  const mock = makeRpcMock([token], pool);
  const prober = createTokenRiskProber(makeClient(mock.fetchImpl), config);
  return prober.assess(token.address, options).then((report) => ({ report, mock }));
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe("evm-token-risk pure helpers", () => {
  it("computeTaxPct: no tax, partial tax, full tax, and degenerate inputs", () => {
    expect(computeTaxPct(100n, 100n)).toBe(0);
    expect(computeTaxPct(1000n, 900n)).toBe(10);
    expect(computeTaxPct(5n, 3n)).toBe(40);
    expect(computeTaxPct(100n, 0n)).toBe(100);
    expect(computeTaxPct(0n, 0n)).toBe(0);
    expect(computeTaxPct(100n, 150n)).toBe(0);
  });

  it("compositeVerdict: any fail rejects, warn-only warns, clean is ok", () => {
    const checks = (overrides: Partial<Record<"sanity" | "tax" | "owner" | "upgradable" | "sellRoute", "pass" | "warn" | "fail" | "skip">>) => {
      const base: Record<"sanity" | "tax" | "owner" | "upgradable" | "sellRoute", "pass" | "warn" | "fail" | "skip"> = {
        sanity: "pass", tax: "pass", owner: "pass", upgradable: "pass", sellRoute: "skip",
      };
      const merged = { ...base, ...overrides };
      return {
        sanity: { status: merged.sanity, detail: "", data: null },
        tax: { status: merged.tax, detail: "", data: null },
        owner: { status: merged.owner, detail: "", data: null },
        upgradable: { status: merged.upgradable, detail: "", data: null },
        sellRoute: { status: merged.sellRoute, detail: "", data: null },
      } as Parameters<typeof compositeVerdict>[0];
    };
    expect(compositeVerdict(checks({}))).toBe("ok");
    expect(compositeVerdict(checks({ owner: "warn" }))).toBe("warn");
    expect(compositeVerdict(checks({ tax: "fail" }))).toBe("reject");
    expect(compositeVerdict(checks({ sanity: "fail", owner: "warn" }))).toBe("reject");
  });
});

// ─── Decision paths ──────────────────────────────────────────────────────────

describe("evm-token-risk decision paths (mocked RPC)", () => {
  it("allowlisted mint → ok with zero RPC calls", async () => {
    const token = cleanToken();
    const allowlisted = new Set([token.address.toLowerCase()]);
    const { report, mock } = await assess(token, { enabled: true, allowlistedMints: allowlisted });
    expect(report.verdict).toBe("ok");
    expect(report.allowlisted).toBe(true);
    expect(report.checks.tax.status).toBe("skip");
    expect(mock.rpcCalls()).toBe(0);
  });

  it("disabled config → ok, disabled, zero RPC calls", async () => {
    const token = cleanToken();
    const { report, mock } = await assess(token, { enabled: false });
    expect(report.verdict).toBe("ok");
    expect(report.disabled).toBe(true);
    expect(report.checks.sanity.status).toBe("skip");
    expect(mock.rpcCalls()).toBe(0);
  });

  it("clean ERC20 → ok with all checks passing", async () => {
    const { report } = await assess(cleanToken(), { enabled: true });
    expect(report.verdict).toBe("ok");
    expect(report.checks.sanity.status).toBe("pass");
    expect(report.checks.tax.status).toBe("pass");
    expect(report.checks.tax.data?.taxPct).toBe(0);
    expect(report.checks.owner.status).toBe("pass");
    expect(report.checks.upgradable.status).toBe("pass");
    expect(report.checks.sellRoute.status).toBe("skip");
  });

  it("decimals() revert → falls back to 18 decimals and still passes", async () => {
    const { report } = await assess(new FakeERC20("0x00000000000000000000000000000000000000bc", { decimalsReverts: true }), { enabled: true });
    expect(report.verdict).toBe("ok");
    expect(report.checks.tax.data?.sent).toBe(10n ** 18n);
  });

  it("transfer tax 10% > max 5% → reject", async () => {
    const { report } = await assess(new FakeERC20("0x00000000000000000000000000000000000000bd", { taxBps: 1000 }), { enabled: true });
    expect(report.verdict).toBe("reject");
    expect(report.checks.tax.status).toBe("fail");
    expect(report.checks.tax.data?.taxPct).toBe(10);
    expect(report.checks.tax.detail).toContain("exceeds max 5%");
  });

  it("transfer tax 3% within the 5% limit → warn", async () => {
    const { report } = await assess(new FakeERC20("0x00000000000000000000000000000000000000be", { taxBps: 300 }), { enabled: true });
    expect(report.verdict).toBe("warn");
    expect(report.checks.tax.status).toBe("warn");
    expect(report.checks.tax.data?.taxPct).toBe(3);
  });

  it("honeypot (funded probe, transfer reverts) → reject with decoded reason", async () => {
    const { report } = await assess(new FakeERC20("0x00000000000000000000000000000000000000bf", { honeypot: true }), { enabled: true });
    expect(report.verdict).toBe("reject");
    expect(report.checks.tax.status).toBe("fail");
    expect(report.checks.tax.detail).toContain("honeypot");
    expect(report.checks.tax.data?.funded).toBe(true);
  });

  it("unfundable storage layout (balance slot 99) → tax warn 'unverifiable', not reject", async () => {
    const { report } = await assess(new FakeERC20("0x00000000000000000000000000000000000000c1", { balanceSlot: 99 }), { enabled: true });
    expect(report.verdict).toBe("warn");
    expect(report.checks.tax.status).toBe("warn");
    expect(report.checks.tax.detail).toContain("unverifiable");
    expect(report.checks.tax.data?.funded).toBe(false);
  });

  it("owner() present → warn with the owner address", async () => {
    const owner = "0x00000000000000000000000000000000000000dd" as Address;
    const { report } = await assess(new FakeERC20("0x00000000000000000000000000000000000000c2", { owner }), { enabled: true });
    expect(report.verdict).toBe("warn");
    expect(report.checks.owner.status).toBe("warn");
    expect(report.checks.owner.data?.owner).toBe(owner.toLowerCase());
  });

  it("pendingOwner() alone → warn", async () => {
    const pending = "0x00000000000000000000000000000000000000de" as Address;
    const { report } = await assess(new FakeERC20("0x00000000000000000000000000000000000000c3", { pendingOwner: pending }), { enabled: true });
    expect(report.verdict).toBe("warn");
    expect(report.checks.owner.data?.pendingOwner).toBe(pending.toLowerCase());
  });

  it("ERC1967 proxy → warn, implementation recorded, sanity scans impl code", async () => {
    const { report } = await assess(
      new FakeERC20("0x00000000000000000000000000000000000000c4", { codeKind: "erc1967", implAddress: IMPL }),
      { enabled: true },
    );
    expect(report.verdict).toBe("warn");
    expect(report.checks.upgradable.status).toBe("warn");
    expect(report.checks.upgradable.data?.isProxy).toBe(true);
    expect(report.checks.upgradable.data?.kind).toBe("erc1967");
    expect(report.checks.upgradable.data?.implementation?.toLowerCase()).toBe(IMPL.toLowerCase());
    expect(report.checks.sanity.status).toBe("pass"); // impl code carries the selectors
  });

  it("EIP-1167 minimal proxy → warn with kind eip1167", async () => {
    const { report } = await assess(
      new FakeERC20("0x00000000000000000000000000000000000000c5", { codeKind: "eip1167", implAddress: IMPL }),
      { enabled: true },
    );
    expect(report.checks.upgradable.data?.isProxy).toBe(true);
    expect(report.checks.upgradable.data?.kind).toBe("eip1167");
    expect(report.checks.upgradable.data?.implementation?.toLowerCase()).toBe(IMPL.toLowerCase());
    expect(report.checks.sanity.status).toBe("pass");
  });

  it("no contract code → reject", async () => {
    const { report } = await assess(new FakeERC20("0x00000000000000000000000000000000000000c6", { codeKind: "none" }), { enabled: true });
    expect(report.verdict).toBe("reject");
    expect(report.checks.sanity.status).toBe("fail");
  });

  it("balanceOf staticcall reverts → reject", async () => {
    const { report } = await assess(new FakeERC20("0x00000000000000000000000000000000000000c7", { balanceOfReverts: true }), { enabled: true });
    expect(report.verdict).toBe("reject");
    expect(report.checks.sanity.status).toBe("fail");
    expect(report.checks.sanity.detail).toContain("staticcall");
  });

  it("sell route out == amountIn → pass, outAmount recorded", async () => {
    const amountIn = 10n ** 18n;
    const token = cleanToken("0x00000000000000000000000000000000000000c8");
    const pool: FakePool = { address: POOL, mode: "ok", outAmount: amountIn, outToken: WETH, revertReason: "pool error" };
    const { report } = await assess(token, { enabled: true }, pool, {
      sellRoute: { poolAddress: POOL, calldata: "0x12345678", amountIn, expectedOutToken: WETH },
    });
    expect(report.checks.sellRoute.status).toBe("pass");
    expect(report.checks.sellRoute.data?.outAmount).toBe(amountIn);
    expect(report.checks.sellRoute.data?.funded).toBe(true);
  });

  it("sell route without expectedOutToken → any non-sold-token credit counts", async () => {
    const amountIn = 10n ** 18n;
    const token = cleanToken("0x00000000000000000000000000000000000000c9");
    const pool: FakePool = { address: POOL, mode: "ok", outAmount: amountIn, outToken: WETH, revertReason: "pool error" };
    const { report } = await assess(token, { enabled: true }, pool, {
      sellRoute: { poolAddress: POOL, calldata: "0x12345678", amountIn },
    });
    expect(report.checks.sellRoute.status).toBe("pass");
  });

  it("sell route swap reverts → reject with decoded reason", async () => {
    const amountIn = 10n ** 18n;
    const token = cleanToken("0x00000000000000000000000000000000000000ca");
    const pool: FakePool = { address: POOL, mode: "revert", outAmount: 0n, outToken: WETH, revertReason: "pool error" };
    const { report } = await assess(token, { enabled: true }, pool, {
      sellRoute: { poolAddress: POOL, calldata: "0x12345678", amountIn, expectedOutToken: WETH },
    });
    expect(report.verdict).toBe("reject");
    expect(report.checks.sellRoute.status).toBe("fail");
    expect(report.checks.sellRoute.detail).toContain("pool error");
  });

  it("sell route with zero out-leg → reject", async () => {
    const amountIn = 10n ** 18n;
    const token = cleanToken("0x00000000000000000000000000000000000000cb");
    const pool: FakePool = { address: POOL, mode: "ok", outAmount: 0n, outToken: WETH, revertReason: "pool error" };
    const { report } = await assess(token, { enabled: true }, pool, {
      sellRoute: { poolAddress: POOL, calldata: "0x12345678", amountIn, expectedOutToken: WETH },
    });
    expect(report.verdict).toBe("reject");
    expect(report.checks.sellRoute.status).toBe("fail");
    expect(report.checks.sellRoute.data?.outAmount).toBe(0n);
  });

  it("sell route absent → skipped, clean token still ok", async () => {
    const { report } = await assess(cleanToken("0x00000000000000000000000000000000000000cc"), { enabled: true });
    expect(report.checks.sellRoute.status).toBe("skip");
    expect(report.verdict).toBe("ok");
  });

  it("tax probe funds via `state` (never stateDiff) with both packings + allowance keys", async () => {
    const amountIn = 10n ** 18n;
    const token = cleanToken("0x00000000000000000000000000000000000000cd");
    const pool: FakePool = { address: POOL, mode: "ok", outAmount: amountIn, outToken: WETH, revertReason: "pool error" };
    const { mock } = await assess(token, { enabled: true }, pool, {
      sellRoute: { poolAddress: POOL, calldata: "0x12345678", amountIn, expectedOutToken: WETH },
    });
    const sims = mock.simulateParams as Array<Array<unknown>>;
    const stateEntries = sims.flatMap((params) =>
      params
        .filter((p): p is { blockStateCalls: Array<{ stateOverrides: Record<string, { state?: Record<string, string>; stateDiff?: unknown }> }> } =>
          typeof p === "object" && p !== null && "blockStateCalls" in p,
        )
        .flatMap((p) => p.blockStateCalls.flatMap((b) => Object.entries(b.stateOverrides ?? {}))),
    );
    expect(stateEntries.length).toBeGreaterThan(0);
    // The sell-route simulation is the LAST eth_simulateV1 request.
    const [, entry] = stateEntries[stateEntries.length - 1]!;
    expect(entry.stateDiff).toBeUndefined();
    expect(entry.state).toBeDefined();
    // standard packing balance key for the probe
    expect(entry.state?.[stdKey(PROBE, 0)]).toBe(numberToHex(amountIn, { size: 32 }));
    // padded packing variant (covers exotic layouts like 4663's WETH)
    expect(entry.state?.[paddedKey(PROBE, 0)]).toBe(numberToHex(amountIn, { size: 32 }));
    // allowance from probe → pool (router transferFrom path)
    expect(entry.state?.[allowanceKeyStd(PROBE, POOL, 0)]).toBe(numberToHex(amountIn, { size: 32 }));
    expect(entry.state?.[allowanceKeyPadded(PROBE, POOL, 0)]).toBe(numberToHex(amountIn, { size: 32 }));
  });
});
