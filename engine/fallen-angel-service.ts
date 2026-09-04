import type { GeckoOhlcvSignals } from "./gecko-ohlcv-service.js";
import type { RugCheckReport } from "./rugcheck-service.js";

/**
 * Fallen-angel gate pipeline (Wave 19) — pure decision module.
 *
 * Decides whether a DLMM pool qualifies as a "fallen angel": the underlying
 * token is deeply down from its all-time high (GeckoTerminal OHLCV), calm
 * enough to mean-revert (daily-return stddev within a band), clean enough to
 * trust (RugCheck: no danger-level risks, low top-10 holder concentration,
 * adequate holder base, sane score), and the pool has any TVL above a
 * configurable floor.
 *
 * Deliberately module-functions only (clone of the depeg detector / token-risk
 * overlay): no Effect Context.Tag, no network calls here. The caller fetches
 * signals via `getGeckoPoolOhlcv` / `getRugCheckReport` and passes them in.
 *
 * FAIL-CLOSED for the positive gate: any signal that is MISSING (null report,
 * null score, null holders) makes the candidate fail with an explicit reason —
 * a token whose security or history is unknown is never an "angel". Only the
 * holder-concentration check fails OPEN when topHolders is absent (the API
 * returns null topHolders for majors like USDC/SOL, and concentration is a
 * secondary signal). No fabricated default is ever substituted.
 */

export interface FallenAngelGateConfig {
  readonly minTvlUsd: number;
  readonly minDrawdownPct: number;
  readonly maxDrawdownPct: number;
  readonly volBaselineMin: number;
  readonly volBaselineMax: number;
  /** RugCheck score_normalised MUST be at or below this (higher = riskier). */
  readonly maxRugcheckScore: number;
  readonly minHolders: number;
  readonly maxTop10HolderPct: number;
}

export interface FallenAngelGateInput {
  readonly poolTvlUsd: number;
  /** The token under scrutiny — the NON-stablecoin leg of the pair. */
  readonly assetMint: string;
  readonly ohlcv: GeckoOhlcvSignals | null;
  readonly rugcheck: RugCheckReport | null;
  readonly config: FallenAngelGateConfig;
}

export interface FallenAngelGateResult {
  readonly qualified: boolean;
  /** Empty when qualified; one entry per failed check otherwise. */
  readonly reasons: ReadonlyArray<string>;
}

/** True when a report carries any risk whose level is "danger" (hard reject). */
export function hasDangerRisks(report: RugCheckReport): boolean {
  return report.dangerRiskCount > 0;
}

function tvlRejection(input: FallenAngelGateInput): string | null {
  if (!Number.isFinite(input.poolTvlUsd) || input.poolTvlUsd < input.config.minTvlUsd) {
    return `TVL $${Number.isFinite(input.poolTvlUsd) ? input.poolTvlUsd.toFixed(0) : "unknown"} below fallen-angel floor $${input.config.minTvlUsd.toFixed(0)}`;
  }
  return null;
}

function ruggedRejection(report: RugCheckReport): string | null {
  if (report.rugged) return "RugCheck flags token as rugged";
  return null;
}

function dangerRejection(report: RugCheckReport): string | null {
  if (hasDangerRisks(report)) {
    const dangerNames = report.risks
      .filter((r) => r.level === "danger")
      .map((r) => r.name)
      .join(", ");
    return `RugCheck danger risks present: ${dangerNames}`;
  }
  return null;
}

function scoreRejection(report: RugCheckReport, config: FallenAngelGateConfig): string | null {
  if (report.scoreNormalised === null) return "RugCheck score unknown — fail closed";
  if (report.scoreNormalised > config.maxRugcheckScore) {
    return `RugCheck risk score ${report.scoreNormalised} exceeds max ${config.maxRugcheckScore}`;
  }
  return null;
}

function mintAuthorityRejection(report: RugCheckReport): string | null {
  if (report.mintAuthority !== null) return "Token mint authority is still enabled";
  return null;
}

function freezeAuthorityRejection(report: RugCheckReport): string | null {
  if (report.freezeAuthority !== null) return "Token freeze authority is still enabled";
  return null;
}

function holderCountRejection(
  report: RugCheckReport,
  config: FallenAngelGateConfig,
): string | null {
  if (report.totalHolders === null) return "RugCheck holder count unknown — fail closed";
  if (report.totalHolders < config.minHolders) {
    return `Holder count ${report.totalHolders} below minimum ${config.minHolders}`;
  }
  return null;
}

// Holder concentration fails OPEN (API returns null topHolders for majors).
// top10HolderPct is a percent (0..100); config.maxTop10HolderPct is a fraction
// (0..1) — normalize to fractions before comparing.
function concentrationRejection(
  report: RugCheckReport,
  config: FallenAngelGateConfig,
): string | null {
  if (report.top10HolderPct !== null && report.top10HolderPct / 100 > config.maxTop10HolderPct) {
    return `Top-10 holder concentration ${report.top10HolderPct.toFixed(1)}% exceeds max ${(config.maxTop10HolderPct * 100).toFixed(0)}%`;
  }
  return null;
}

// ── Security gate (RugCheck) — fail-closed on missing data ────────────────
function collectRugCheckReasons(
  report: RugCheckReport | null,
  config: FallenAngelGateConfig,
): string[] {
  if (report === null) return ["RugCheck report unavailable — security unknown"];
  const helpers: Array<string | null> = [
    ruggedRejection(report),
    dangerRejection(report),
    scoreRejection(report, config),
    mintAuthorityRejection(report),
    freezeAuthorityRejection(report),
    holderCountRejection(report, config),
    concentrationRejection(report, config),
  ];
  return helpers.filter((r): r is string => r !== null);
}

function barCountRejection(ohlcv: GeckoOhlcvSignals): string | null {
  if (ohlcv.barCount < 2) return `OHLCV window too shallow (${ohlcv.barCount} bar(s))`;
  return null;
}

function drawdownMinRejection(
  ohlcv: GeckoOhlcvSignals,
  config: FallenAngelGateConfig,
): string | null {
  if (ohlcv.drawdownFromAth < config.minDrawdownPct) {
    return `Drawdown from ATH ${(ohlcv.drawdownFromAth * 100).toFixed(1)}% below minimum ${(config.minDrawdownPct * 100).toFixed(0)}%`;
  }
  return null;
}

function drawdownMaxRejection(
  ohlcv: GeckoOhlcvSignals,
  config: FallenAngelGateConfig,
): string | null {
  if (ohlcv.drawdownFromAth > config.maxDrawdownPct) {
    return `Drawdown from ATH ${(ohlcv.drawdownFromAth * 100).toFixed(1)}% exceeds maximum ${(config.maxDrawdownPct * 100).toFixed(0)}% (dead token)`;
  }
  return null;
}

function volMinRejection(ohlcv: GeckoOhlcvSignals, config: FallenAngelGateConfig): string | null {
  if (ohlcv.dailyReturnStddev < config.volBaselineMin) {
    return `Daily-return stddev ${ohlcv.dailyReturnStddev.toFixed(4)} below volatility floor ${config.volBaselineMin}`;
  }
  return null;
}

function volMaxRejection(ohlcv: GeckoOhlcvSignals, config: FallenAngelGateConfig): string | null {
  if (ohlcv.dailyReturnStddev > config.volBaselineMax) {
    return `Daily-return stddev ${ohlcv.dailyReturnStddev.toFixed(4)} above volatility ceiling ${config.volBaselineMax} (lunatic token)`;
  }
  return null;
}

// ── History gate (GeckoTerminal OHLCV) — fail-closed on missing data ──────
function collectOhlcvReasons(
  ohlcv: GeckoOhlcvSignals | null,
  config: FallenAngelGateConfig,
): string[] {
  if (ohlcv === null) return ["OHLCV history unavailable — drawdown unknown"];
  const helpers: Array<string | null> = [
    barCountRejection(ohlcv),
    drawdownMinRejection(ohlcv, config),
    drawdownMaxRejection(ohlcv, config),
    volMinRejection(ohlcv, config),
    volMaxRejection(ohlcv, config),
  ];
  return helpers.filter((r): r is string => r !== null);
}

export function evaluateFallenAngelGate(input: FallenAngelGateInput): FallenAngelGateResult {
  const reasons: string[] = [];
  const tvl = tvlRejection(input);
  if (tvl !== null) reasons.push(tvl);
  reasons.push(...collectRugCheckReasons(input.rugcheck, input.config));
  reasons.push(...collectOhlcvReasons(input.ohlcv, input.config));
  return { qualified: reasons.length === 0, reasons };
}

/**
 * Pick the asset leg of a pool pair: the mint that is NOT a stablecoin and
 * NOT SOL (the base settlement asset). When both legs are stablecoins there is
 * no obvious asset — return null and let the caller fail closed. When the
 * allowlist is empty (undefined) there is no notion of a stable leg, so the
 * pair is unclassifiable — return null (fail closed) rather than guessing.
 * SOL is always excluded: it is the settlement/quote leg, never the
 * fallen-angel asset (RugCheck reports for SOL carry no useful signal).
 */
export function identifyAssetMint(
  tokenX: string,
  tokenY: string,
  stablecoinMints: ReadonlySet<string> | undefined,
  solMint: string,
): string | null {
  if (stablecoinMints === undefined || stablecoinMints.size === 0) return null;
  const xIsStable = stablecoinMints.has(tokenX) || tokenX === solMint;
  const yIsStable = stablecoinMints.has(tokenY) || tokenY === solMint;
  if (!xIsStable && yIsStable) return tokenX;
  if (xIsStable && !yIsStable) return tokenY;
  if (xIsStable && yIsStable) return null;
  // Neither leg is stable/SOL — prefer the first (tokenX) as the asset.
  return tokenX;
}
