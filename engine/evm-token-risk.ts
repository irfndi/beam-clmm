/**
 * EVM token-risk prober: read-only (eth_call / eth_simulateV1) risk assessment
 * of an ERC20 mint before the engine commits liquidity against it.
 *
 * Checks:
 *   (a) sanity      — contract code present, standard method selectors present
 *                     in the (resolved) runtime code, balanceOf staticcall ok.
 *   (b) transfer tax — simulate a funded transfer (state-override funding at
 *                     candidate storage layouts) and measure the recipient's
 *                     net delta vs the sent amount; a revert on a FUNDED probe
 *                     is a honeypot signal.
 *   (c) owner control — owner()/pendingOwner() non-reverting ⇒ centralisation.
 *   (d) upgradable  — ERC1967 implementation slot / EIP-1167 marker ⇒ proxy.
 *   (e) sell route  — eth_simulateV1 swap of a realistic legs size → out-leg
 *                     credit > 0, using the caller-supplied pool address and
 *                     calldata (the caller owns swap construction).
 *
 * All RPC access goes through the injected viem PublicClient (only its
 * `request` surface is used), so the module is pure and the live path is
 * exactly the mocked path. Fail-closed: a check that cannot conclude reports
 * warn/fail rather than pass.
 *
 * Chain-4663 live findings that shaped this module (verified 2026-08-10):
 *   - eth_simulateV1 IS supported and returns per-call status/logs/returnData;
 *     plain eth_call returns data only (no logs).
 *   - state-override `state` (full storage replacement) and `code` are honored;
 *     `stateDiff` is silently ignored → this module always uses `state`.
 *   - the probe address must be funded at candidate balance slots in BOTH the
 *     standard packing (keccak(abi.encodePacked(addr, slot))) and the padded
 *     packing (keccak(abi.encode(addr, slot))); Robinhood-native tokens
 *     (WETH/USDG) use exotic layouts the default candidate range misses, so a
 *     funding-verification call discriminates "unfunded probe" (warn,
 *     unverifiable) from "genuine honeypot" (fail).
 */

import {
  type Address,
  type Hex,
  type PublicClient,
  decodeErrorResult,
  keccak256,
  numberToHex,
} from "viem";

// ─── Public types ────────────────────────────────────────────────────────────

export type TokenRiskVerdict = "ok" | "warn" | "reject";
export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface TokenRiskConfig {
  readonly enabled: boolean;
  /** Transfer-tax ceiling in percent. Default 5. */
  readonly maxTransferTaxPct?: number;
  /** Lowercase mint addresses that skip assessment and always report ok. */
  readonly allowlistedMints?: ReadonlySet<string>;
}

/**
 * Sell-route descriptor for check (e). The caller owns swap construction and
 * passes the exact eth_call-able calldata for a realistic legs size.
 * `calldata` must execute from the probe address and must be single-hop where
 * the token pull is satisfied by (probe balance + allowance(probe → pool)) or
 * by the pool's own token balance (direct pool.swap style); both are funded
 * by the probe.
 */
export interface SellRouteSpec {
  readonly poolAddress: Address;
  readonly calldata: Hex;
  /** Legs size the calldata was built for (also the simulated funding amount). */
  readonly amountIn: bigint;
  /** Constrain the out-leg scan to this token (default: any non-sold-token Transfer). */
  readonly expectedOutToken?: Address;
}

export interface CheckResult<T> {
  readonly status: CheckStatus;
  readonly detail: string;
  readonly data: T | null;
}

export interface SanityDetail {
  readonly codeSource: "token" | "erc1967" | "eip1167" | "none";
  readonly codeBytes: number;
  readonly methodsPresent: { readonly balanceOf: boolean; readonly transfer: boolean };
  readonly staticcallOk: boolean;
}

export interface TaxDetail {
  readonly sent: bigint;
  readonly received: bigint | null;
  readonly taxPct: number | null;
  readonly funded: boolean;
  readonly revertReason: string | null;
}

export interface OwnerDetail {
  readonly owner: Address | null;
  readonly pendingOwner: Address | null;
}

export interface UpgradableDetail {
  readonly isProxy: boolean;
  readonly kind: "erc1967" | "eip1167" | null;
  readonly implementation: Address | null;
}

export interface SellRouteDetail {
  readonly poolAddress: Address;
  readonly amountIn: bigint;
  readonly outAmount: bigint | null;
  readonly funded: boolean;
  readonly revertReason: string | null;
  readonly expectedOutToken: Address | null;
}

export interface TokenRiskReport {
  readonly token: Address;
  readonly verdict: TokenRiskVerdict;
  readonly allowlisted: boolean;
  readonly disabled: boolean;
  readonly checks: {
    readonly sanity: CheckResult<SanityDetail>;
    readonly tax: CheckResult<TaxDetail>;
    readonly owner: CheckResult<OwnerDetail>;
    readonly upgradable: CheckResult<UpgradableDetail>;
    readonly sellRoute: CheckResult<SellRouteDetail>;
  };
}

export interface TokenRiskProber {
  assess(token: Address, options?: { readonly sellRoute?: SellRouteSpec }): Promise<TokenRiskReport>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_TRANSFER_TAX_PCT = 5;
const MAX_BALANCE_SLOT = 9; // candidate balance-slot indices (both packings)
const MAX_ALLOWANCE_SLOT = 1;

/** Neutral addresses used as the funded seller and the tax-measurement recipient. */
const PROBE_ADDRESS = "0x0000000000000000000000000000000000000002" as const;
const PROBE_RECIPIENT = "0x0000000000000000000000000000000000000003" as const;

const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
/** TransparentUpgradeableProxy admin slot (preserved when replacing storage). */
const PROXY_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as const;
/** EIP-1167 minimal-proxy marker; the implementation address follows it. */
const MINIMAL_PROXY_MARKER = "0x363d3d373d3d3d3d363d73";

const BALANCE_OF_SELECTOR = "0x70a08231";
const TRANSFER_SELECTOR = "0xa9059cbb";
const DECIMALS_SELECTOR = "0x313ce567";
const OWNER_SELECTOR = "0x8da5cb5b";
const PENDING_OWNER_SELECTOR = "0xe30c3978";
const TRANSFER_EVENT_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

const REVERT_ERROR_ABI = [
  { type: "error", name: "Error", inputs: [{ type: "string", name: "reason" }] },
  { type: "error", name: "Panic", inputs: [{ type: "uint256", name: "code" }] },
] as const;

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

/**
 * Transfer-tax as a percent (0..100, 2 decimals) lost between `sent` and
 * `received`. Never negative: a recipient receiving more than sent is 0% tax.
 */
export function computeTaxPct(sent: bigint, received: bigint): number {
  if (sent <= 0n) return 0;
  if (received >= sent) return 0;
  const lost = sent - received;
  return Number((lost * 10000n) / sent) / 100;
}

/** Composite rule: any fail ⇒ reject, else any warn ⇒ warn, else ok. */
export function compositeVerdict(checks: TokenRiskReport["checks"]): TokenRiskVerdict {
  const statuses = [
    checks.sanity.status,
    checks.tax.status,
    checks.owner.status,
    checks.upgradable.status,
    checks.sellRoute.status,
  ];
  if (statuses.some((s) => s === "fail")) return "reject";
  if (statuses.some((s) => s === "warn")) return "warn";
  return "ok";
}

// ─── Internal helpers ────────────────────────────────────────────────────────

type StateOverride = Record<string, { state: Record<Hex, Hex> }>;

interface SimLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

interface SimCallResult {
  readonly returnData: Hex;
  readonly status: "0x0" | "0x1";
  readonly logs: readonly SimLog[];
}

interface SimCallRequest {
  readonly from?: Address;
  readonly to: Address;
  readonly data: Hex;
}

interface ResolvedImpl {
  readonly kind: "erc1967" | "eip1167";
  readonly implementation: Address;
  readonly code: Hex;
}

function isNonZero(value: Hex | null): boolean {
  if (!value || value === "0x" || value === "0x0") return false;
  return value !== `0x${"0".repeat(64)}`;
}

function toBigInt(hex: Hex | null | undefined): bigint {
  if (!hex || hex === "0x" || hex === "0x0") return 0n;
  try {
    return BigInt(hex);
  } catch {
    return 0n;
  }
}

/** keccak256(abi.encodePacked(addr, uint256(slot))) — the standard mapping key. */
function balanceKey(holder: Address, slot: number): Hex {
  const addr = holder.toLowerCase().slice(2);
  const slotWord = numberToHex(BigInt(slot), { size: 32 }).slice(2);
  return keccak256(`0x${addr}${slotWord}`);
}

/** keccak256(abi.encode(addr, uint256(slot))) — address padded to 32 bytes. */
function balanceKeyPadded(holder: Address, slot: number): Hex {
  const addr = holder.toLowerCase().slice(2).padStart(64, "0");
  const slotWord = numberToHex(BigInt(slot), { size: 32 }).slice(2);
  return keccak256(`0x${addr}${slotWord}`);
}

/** keccak256(abi.encodePacked(owner, keccak256(abi.encodePacked(spender, uint256(slot))))) */
function allowanceKey(owner: Address, spender: Address, slot: number): Hex {
  const inner = balanceKey(spender, slot);
  return keccak256(`0x${owner.toLowerCase().slice(2)}${inner.slice(2)}`);
}

/** Padded-address variant of allowanceKey. */
function allowanceKeyPadded(owner: Address, spender: Address, slot: number): Hex {
  const inner = balanceKeyPadded(spender, slot);
  return keccak256(`0x${owner.toLowerCase().slice(2).padStart(64, "0")}${inner.slice(2)}`);
}

function encodeBalanceOf(addr: Address): Hex {
  return `0x${BALANCE_OF_SELECTOR.slice(2)}${addr.toLowerCase().slice(2).padStart(64, "0")}`;
}

function encodeTransfer(to: Address, amount: bigint): Hex {
  return `0x${TRANSFER_SELECTOR.slice(2)}${to
    .toLowerCase()
    .slice(2)
    .padStart(64, "0")}${numberToHex(amount, { size: 32 }).slice(2)}`;
}

function extractRevertReason(returnData: Hex | null | undefined): string {
  if (!returnData || returnData === "0x" || returnData.length < 10) return "execution reverted";
  try {
    const decoded = decodeErrorResult({ abi: REVERT_ERROR_ABI, data: returnData });
    if (decoded.errorName === "Error") return `Error(${decoded.args[0] ?? ""})`;
    if (decoded.errorName === "Panic") return `Panic(${decoded.args[0] ?? ""})`;
  } catch {
    // unknown selector — fall through to the raw prefix
  }
  return `revert ${returnData.slice(0, 10)}`;
}

/** Sum Transfer-log values crediting `holder`, filtered by out-leg constraints. */
function sumOutLeg(
  logs: readonly SimLog[],
  soldToken: Address,
  expectedOutToken: Address | null,
  holder: Address,
): bigint {
  let total = 0n;
  for (const log of logs) {
    if (log.topics.length !== 3) continue;
    if (log.topics[0] !== TRANSFER_EVENT_TOPIC) continue;
    // Transfer topics carry 32-byte padded addresses; compare the last 20 bytes.
    const toAddr = log.topics[2];
    if (!toAddr || toAddr.slice(26).toLowerCase() !== holder.toLowerCase().slice(2)) continue;
    if (expectedOutToken) {
      if (log.address.toLowerCase() !== expectedOutToken.toLowerCase()) continue;
    } else if (log.address.toLowerCase() === soldToken.toLowerCase()) {
      continue; // in-leg / internal movement of the sold token is not out-leg
    }
    total += toBigInt(log.data);
  }
  return total;
}

async function getCodeSafe(client: PublicClient, address: Address): Promise<Hex | null> {
  try {
    const res = (await client.request({
      method: "eth_getCode",
      params: [address, "latest"],
    })) as unknown;
    return typeof res === "string" && res.startsWith("0x") ? (res as Hex) : null;
  } catch {
    return null;
  }
}

async function getStorageAtSafe(client: PublicClient, address: Address, slot: Hex): Promise<Hex | null> {
  try {
    const res = (await client.request({
      method: "eth_getStorageAt",
      params: [address, slot, "latest"],
    })) as unknown;
    return typeof res === "string" && res.startsWith("0x") ? (res as Hex) : null;
  } catch {
    return null;
  }
}

/** Resolve the code that actually implements the token's logic. */
async function resolveImplementation(client: PublicClient, token: Address): Promise<ResolvedImpl | null> {
  const code = await getCodeSafe(client, token);
  if (!code || code === "0x") return null;

  const implSlot = await getStorageAtSafe(client, token, ERC1967_IMPLEMENTATION_SLOT);
  if (implSlot && isNonZero(implSlot)) {
    const implementation = `0x${implSlot.slice(26)}` as Address;
    const implCode = await getCodeSafe(client, implementation);
    if (implCode && implCode !== "0x") return { kind: "erc1967", implementation, code: implCode };
  }

  const markerIndex = code.indexOf(MINIMAL_PROXY_MARKER.slice(2));
  if (markerIndex >= 0) {
    const implementation = `0x${code.slice(markerIndex + 22, markerIndex + 62)}` as Address;
    const implCode = await getCodeSafe(client, implementation);
    if (implCode && implCode !== "0x") return { kind: "eip1167", implementation, code: implCode };
  }
  return null;
}

/**
 * Build the RPC-form state override that funds `funded` addresses with
 * `amount` at candidate balance slots (both packings), grants allowance from
 * PROBE_ADDRESS to each `spender`, and preserves proxy slots. Uses `state`
 * (full replacement) — `stateDiff` is silently ignored on chain 4663.
 */
async function buildFundingState(
  client: PublicClient,
  token: Address,
  funded: readonly Address[],
  amount: bigint,
  spenders: readonly Address[],
): Promise<StateOverride> {
  const state: Record<Hex, Hex> = {};
  const amountHex = numberToHex(amount, { size: 32 });
  for (const holder of funded) {
    for (let slot = 0; slot <= MAX_BALANCE_SLOT; slot++) {
      state[balanceKey(holder, slot)] = amountHex;
      state[balanceKeyPadded(holder, slot)] = amountHex;
    }
  }
  for (const spender of spenders) {
    for (let slot = 0; slot <= MAX_ALLOWANCE_SLOT; slot++) {
      state[allowanceKey(PROBE_ADDRESS, spender, slot)] = amountHex;
      state[allowanceKeyPadded(PROBE_ADDRESS, spender, slot)] = amountHex;
    }
  }
  const impl = await getStorageAtSafe(client, token, ERC1967_IMPLEMENTATION_SLOT);
  if (impl && isNonZero(impl)) {
    state[ERC1967_IMPLEMENTATION_SLOT] = impl;
    const admin = await getStorageAtSafe(client, token, PROXY_ADMIN_SLOT);
    if (admin && isNonZero(admin)) state[PROXY_ADMIN_SLOT] = admin;
  }
  return { [token.toLowerCase()]: { state } };
}

/** eth_simulateV1 single block; returns the per-call results or null when the method is unsupported/errors. */
async function simulateCalls(
  client: PublicClient,
  calls: readonly SimCallRequest[],
  stateOverrides: StateOverride,
): Promise<readonly SimCallResult[] | null> {
  try {
    const res = (await client.request({
      method: "eth_simulateV1",
      // op-geth accepts the second (block-tag) param — verified live on 4663.
      params: [{ blockStateCalls: [{ blockOverrides: {}, calls: [...calls], stateOverrides }] }, "latest"],
    })) as unknown;
    const blocks = Array.isArray(res) ? (res as Array<{ calls?: unknown }>) : null;
    const blockCalls = blocks?.[0]?.calls;
    if (!Array.isArray(blockCalls)) return null;
    return blockCalls.map((entry) => {
      const raw = entry as { returnData?: unknown; status?: unknown; logs?: unknown };
      return {
        returnData: typeof raw.returnData === "string" ? (raw.returnData as Hex) : "0x",
        status: raw.status === "0x0" ? "0x0" : "0x1",
        logs: Array.isArray(raw.logs) ? (raw.logs as SimLog[]) : [],
      };
    });
  } catch {
    return null;
  }
}

async function ethCallRaw(
  client: PublicClient,
  tx: { readonly from?: Address; readonly to: Address; readonly data: Hex },
): Promise<{ readonly ok: boolean; readonly data: Hex | null }> {
  try {
    const res = (await client.request({
      method: "eth_call",
      params: [tx, "latest"],
    })) as unknown;
    return { ok: true, data: typeof res === "string" ? (res as Hex) : null };
  } catch {
    return { ok: false, data: null };
  }
}

async function readAddress(client: PublicClient, to: Address, selector: Hex): Promise<Address | null> {
  const res = await ethCallRaw(client, { to, data: selector });
  if (!res.ok || !res.data || res.data === "0x" || res.data.length < 66) return null;
  return `0x${res.data.slice(26)}` as Address;
}

async function readDecimals(client: PublicClient, token: Address): Promise<bigint> {
  const res = await ethCallRaw(client, { to: token, data: DECIMALS_SELECTOR });
  if (!res.ok || !res.data || res.data === "0x" || res.data.length < 66) return 18n;
  const raw = toBigInt(res.data);
  return raw > 255n ? 18n : raw;
}

async function runCheck<T>(fn: () => Promise<CheckResult<T>>): Promise<CheckResult<T>> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "fail", detail: `probe error: ${message}`, data: null };
  }
}

// ─── Individual checks ───────────────────────────────────────────────────────

async function checkSanity(
  client: PublicClient,
  token: Address,
  impl: ResolvedImpl | null,
): Promise<CheckResult<SanityDetail>> {
  const code = await getCodeSafe(client, token);
  if (!code || code === "0x") {
    return {
      status: "fail",
      detail: "no contract code at address",
      data: { codeSource: "none", codeBytes: 0, methodsPresent: { balanceOf: false, transfer: false }, staticcallOk: false },
    };
  }
  const scanCode = impl ? impl.code : code;
  const methodsPresent = {
    balanceOf: scanCode.includes(BALANCE_OF_SELECTOR.slice(2)),
    transfer: scanCode.includes(TRANSFER_SELECTOR.slice(2)),
  };
  const staticcallOk = (await ethCallRaw(client, { to: token, data: encodeBalanceOf(PROBE_ADDRESS) })).ok;
  const data: SanityDetail = {
    codeSource: impl ? impl.kind : "token",
    codeBytes: (code.length - 2) / 2,
    methodsPresent,
    staticcallOk,
  };
  if (!staticcallOk) {
    return { status: "fail", detail: "balanceOf staticcall reverted", data };
  }
  if (!methodsPresent.balanceOf || !methodsPresent.transfer) {
    return {
      status: "warn",
      detail: `missing standard methods (balanceOf: ${methodsPresent.balanceOf}, transfer: ${methodsPresent.transfer})`,
      data,
    };
  }
  return { status: "pass", detail: `ERC20 sanity ok (${data.codeBytes} code bytes)`, data };
}

async function checkTax(client: PublicClient, token: Address, maxTax: number): Promise<CheckResult<TaxDetail>> {
  const sent = 10n ** (await readDecimals(client, token));
  const stateOverride = await buildFundingState(client, token, [PROBE_ADDRESS], sent, []);
  const results = await simulateCalls(
    client,
    [
      { from: PROBE_ADDRESS, to: token, data: encodeBalanceOf(PROBE_ADDRESS) }, // funding verify
      { from: PROBE_ADDRESS, to: token, data: encodeBalanceOf(PROBE_RECIPIENT) }, // b0
      { from: PROBE_ADDRESS, to: token, data: encodeTransfer(PROBE_RECIPIENT, sent) }, // transfer
      { from: PROBE_ADDRESS, to: token, data: encodeBalanceOf(PROBE_RECIPIENT) }, // b1
    ],
    stateOverride,
  );
  if (!results) {
    return {
      status: "warn",
      detail: "eth_simulateV1 unsupported on this RPC; transfer tax unverifiable",
      data: { sent, received: null, taxPct: null, funded: false, revertReason: null },
    };
  }
  if (results.length < 4) {
    return { status: "fail", detail: "simulation returned incomplete results", data: { sent, received: null, taxPct: null, funded: false, revertReason: null } };
  }
  const [fundedCall, b0Call, transferCall, b1Call] = results;
  if (!fundedCall || !b0Call || !transferCall || !b1Call) {
    return { status: "fail", detail: "simulation returned incomplete results", data: { sent, received: null, taxPct: null, funded: false, revertReason: null } };
  }
  const funded = toBigInt(fundedCall.returnData) >= sent;
  if (!funded) {
    return {
      status: "warn",
      detail: "could not fund probe address (non-standard storage layout); transfer tax unverifiable",
      data: { sent, received: null, taxPct: null, funded: false, revertReason: null },
    };
  }
  if (transferCall.status !== "0x1") {
    const reason = extractRevertReason(transferCall.returnData);
    return {
      status: "fail",
      detail: `transfer reverted: ${reason} (honeypot)`,
      data: { sent, received: 0n, taxPct: 100, funded: true, revertReason: reason },
    };
  }
  const received = toBigInt(b1Call.returnData) - toBigInt(b0Call.returnData);
  const taxPct = computeTaxPct(sent, received);
  if (received <= 0n) {
    return {
      status: "fail",
      detail: "transfer credited nothing to the recipient (100% tax or honeypot)",
      data: { sent, received, taxPct: 100, funded, revertReason: null },
    };
  }
  if (taxPct > maxTax) {
    return {
      status: "fail",
      detail: `transfer tax ${taxPct}% exceeds max ${maxTax}%`,
      data: { sent, received, taxPct, funded, revertReason: null },
    };
  }
  if (taxPct > 0) {
    return {
      status: "warn",
      detail: `transfer tax ${taxPct}% within the ${maxTax}% limit`,
      data: { sent, received, taxPct, funded, revertReason: null },
    };
  }
  return {
    status: "pass",
    detail: "no transfer tax detected",
    data: { sent, received, taxPct: 0, funded, revertReason: null },
  };
}

async function checkOwner(client: PublicClient, token: Address): Promise<CheckResult<OwnerDetail>> {
  const owner = await readAddress(client, token, OWNER_SELECTOR);
  const pendingOwner = await readAddress(client, token, PENDING_OWNER_SELECTOR);
  const data: OwnerDetail = { owner, pendingOwner };
  if (owner !== null || pendingOwner !== null) {
    return {
      status: "warn",
      detail: `owner-controlled token (owner=${owner ?? "n/a"}, pendingOwner=${pendingOwner ?? "n/a"})`,
      data,
    };
  }
  return { status: "pass", detail: "no owner()/pendingOwner()", data };
}

async function checkUpgradable(impl: ResolvedImpl | null): Promise<CheckResult<UpgradableDetail>> {
  if (impl) {
    return {
      status: "warn",
      detail: `${impl.kind} proxy, implementation ${impl.implementation} (upgradeable)`,
      data: { isProxy: true, kind: impl.kind, implementation: impl.implementation },
    };
  }
  return { status: "pass", detail: "not a proxy", data: { isProxy: false, kind: null, implementation: null } };
}

async function checkSellRoute(
  client: PublicClient,
  token: Address,
  spec: SellRouteSpec | undefined,
): Promise<CheckResult<SellRouteDetail>> {
  if (!spec) {
    return { status: "skip", detail: "no sell route provided", data: null };
  }
  const { poolAddress, calldata, amountIn, expectedOutToken } = spec;
  const base: SellRouteDetail = {
    poolAddress,
    amountIn,
    outAmount: null,
    funded: false,
    revertReason: null,
    expectedOutToken: expectedOutToken ?? null,
  };
  const stateOverride = await buildFundingState(client, token, [PROBE_ADDRESS, poolAddress], amountIn, [poolAddress]);
  const results = await simulateCalls(
    client,
    [
      { from: PROBE_ADDRESS, to: token, data: encodeBalanceOf(PROBE_ADDRESS) }, // funding verify
      { from: PROBE_ADDRESS, to: poolAddress, data: calldata }, // the swap
    ],
    stateOverride,
  );
  if (!results) {
    return {
      status: "warn",
      detail: "eth_simulateV1 unsupported on this RPC; sell route unverifiable",
      data: base,
    };
  }
  const [fundedCall, swapCall] = results;
  if (!fundedCall || !swapCall) {
    return { status: "fail", detail: "simulation returned incomplete results", data: base };
  }
  const funded = toBigInt(fundedCall.returnData) >= amountIn;
  if (!funded) {
    return {
      status: "warn",
      detail: "could not fund probe (non-standard storage layout); sell route unverifiable",
      data: base,
    };
  }
  if (swapCall.status !== "0x1") {
    const reason = extractRevertReason(swapCall.returnData);
    return {
      status: "fail",
      detail: `sell swap reverted: ${reason}`,
      data: { ...base, funded, outAmount: 0n, revertReason: reason },
    };
  }
  const outAmount = sumOutLeg(swapCall.logs, token, expectedOutToken ?? null, PROBE_ADDRESS);
  if (outAmount <= 0n) {
    return {
      status: "fail",
      detail: "sell swap produced no out-leg credit to the holder",
      data: { ...base, funded, outAmount: 0n },
    };
  }
  if (outAmount < amountIn) {
    const costPct = computeTaxPct(amountIn, outAmount);
    return {
      status: "warn",
      detail: `sell route credits ${outAmount} of ${amountIn} in (${costPct}% route cost)`,
      data: { ...base, funded, outAmount },
    };
  }
  return {
    status: "pass",
    detail: `sell route verified: ${outAmount} out for ${amountIn} in`,
    data: { ...base, funded, outAmount },
  };
}

// ─── Prober factory ──────────────────────────────────────────────────────────

function skippedChecks(reason: string): TokenRiskReport["checks"] {
  const skip = (): CheckResult<never> => ({ status: "skip", detail: reason, data: null });
  return { sanity: skip(), tax: skip(), owner: skip(), upgradable: skip(), sellRoute: skip() };
}

export function createTokenRiskProber(client: PublicClient, config: TokenRiskConfig): TokenRiskProber {
  const maxTax = config.maxTransferTaxPct ?? DEFAULT_MAX_TRANSFER_TAX_PCT;
  const allowlist = config.allowlistedMints ?? new Set<string>();

  return {
    async assess(token, options) {
      if (allowlist.has(token.toLowerCase())) {
        return { token, verdict: "ok", allowlisted: true, disabled: false, checks: skippedChecks("allowlisted mint") };
      }
      if (!config.enabled) {
        return { token, verdict: "ok", allowlisted: false, disabled: true, checks: skippedChecks("risk assessment disabled") };
      }
      // Resolved once; shared by sanity (code scan) and upgradable (proxy detection).
      const impl = await resolveImplementation(client, token).catch(() => null);
      const checks = {
        sanity: await runCheck(() => checkSanity(client, token, impl)),
        tax: await runCheck(() => checkTax(client, token, maxTax)),
        owner: await runCheck(() => checkOwner(client, token)),
        upgradable: await runCheck(() => checkUpgradable(impl)),
        sellRoute: await runCheck(() => checkSellRoute(client, token, options?.sellRoute)),
      };
      return { token, verdict: compositeVerdict(checks), allowlisted: false, disabled: false, checks };
    },
  };
}
