/* oxlint-disable */
import { Effect, Layer } from "effect";
import { randomUUID } from "crypto";
import { AuditService, type AuditApi } from "./services.js";
import { DbService } from "./services.js";
import type { PoolMetrics } from "./types.js";
import { stringifySafe, parseBigIntSafe } from "./bigint-json.js";

interface RiskResult {
  approved: boolean;
  reason: string;
  adjustedSizeUsd?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRiskResult(json: string | null): RiskResult {
  if (!json) return { approved: false, reason: "unknown" };
  try {
    const parsed: unknown = JSON.parse(json);
    // DB-sourced riskResultJson is untrusted: validate the shape instead of
    // asserting, so a null/array/odd-typed value cannot masquerade as a
    // valid risk result (which would fail the caller's fallback logic).
    if (
      isRecord(parsed) &&
      typeof parsed.approved === "boolean" &&
      (parsed.reason === undefined || typeof parsed.reason === "string")
    ) {
      return {
        approved: parsed.approved,
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
        ...(typeof parsed.adjustedSizeUsd === "number" && {
          adjustedSizeUsd: parsed.adjustedSizeUsd,
        }),
      };
    }
    return { approved: false, reason: "unknown" };
  } catch {
    // DB-sourced riskResultJson may be malformed (older rows, partial writes);
    // a bad parse must never fail the whole getRecentDecisions call.
    return { approved: false, reason: "unknown" };
  }
}

export const AuditLive = Layer.effect(
  AuditService,
  Effect.gen(function* () {
    const db = yield* DbService;

    const api: AuditApi = {
      recordDecision: (record) =>
        Effect.gen(function* () {
          yield* db.saveAudit({
            // Unique per decision: a pool now yields several decisions in one
            // cycle (multiple positions), and two same-pool decisions in the
            // same millisecond must not collide on the primary key.
            id: `${record.cycleId}-${record.poolAddress}-${record.timestamp}-${randomUUID()}`,
            timestamp: record.timestamp,
            cycleId: record.cycleId,
            poolAddress: record.poolAddress,
            action: record.action,
            confidence: record.confidence,
            reasoning: record.reasoning,
            metricsJson: record.metrics ? stringifySafe(record.metrics) : null,
            riskResultJson: stringifySafe(record.riskResult),
            executed: record.executed,
            paperTrading: record.paperTrading,
            txSignature: record.txSignature ?? null,
            error: record.error ?? null,
          });
        }),

      getRecentDecisions: (limit = 100) =>
        Effect.gen(function* () {
          const rows = yield* db.getRecentAudit(limit);
          return rows.map((row) => ({
            timestamp: row.timestamp,
            cycleId: row.cycleId,
            poolAddress: row.poolAddress,
            action: row.action,
            confidence: row.confidence,
            reasoning: row.reasoning,
            metrics: row.metricsJson ? parseBigIntSafe<PoolMetrics>(row.metricsJson) : undefined,
            riskResult: parseRiskResult(row.riskResultJson),
            executed: row.executed,
            paperTrading: row.paperTrading,
            txSignature: row.txSignature ?? undefined,
            error: row.error ?? undefined,
          }));
        }),
    };

    return api;
  }),
);
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof */
