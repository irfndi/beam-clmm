/* oxlint-disable */
/**
 * Privacy-first error reporter for Beam.
 *
 * - Sanitizes stack traces and messages (replaces long private-key-looking strings, private keys, passwords)
 * - Buffers reports in memory and flushes in batches (5 reports or 60 seconds)
 * - Sends to a configurable endpoint via fetch (BEAM_ERROR_ENDPOINT env var, defaults to production API)
 * - If the endpoint fetch fails, the batch is re-queued at the front of the pending buffer
 *   (oldest reports beyond MAX_PENDING_BUFFER are dropped to bound memory)
 * - Classifies errors by string match
 * - If BEAM_ERROR_REPORTING env var is "false", the reporter is a no-op (opt-out)
 * - For testability: flushAsync(), getPending(), and createErrorReporter(config) factory
 */

import { existsSync, readFileSync } from "fs";
import { Effect } from "effect";
import { join } from "path";
import { getBeamUserConfigDir } from "./paths.js";
import { readTelemetryPreference } from "./telemetry-preference.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ErrorCategory =
  | "ONNX_BigInt"
  | "SQLite_Vec"
  | "RPC_RateLimit"
  | "UpdateFailure"
  | "RPC_Error"
  | "Config_Error"
  | "Unknown";

export type ErrorSeverity = "low" | "medium" | "high" | "critical";

export interface ReportContext {
  readonly cycleId?: string;
  readonly poolAddress?: string;
  readonly severity?: ErrorSeverity;
}

export interface ErrorReport {
  readonly id: string;
  readonly agentId: string;
  readonly ts: string;
  readonly message: string;
  readonly stack: string;
  readonly category: ErrorCategory;
  readonly severity: ErrorSeverity;
  readonly cycleId?: string;
  readonly poolAddress?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ErrorReporterConfig {
  readonly endpoint?: string;
  readonly enabled?: boolean;
  readonly optOut?: boolean;
  readonly agentId?: string;
  readonly flushIntervalMs?: number;
  readonly batchSize?: number;
  /**
   * How long to wait (ms) after a non-OK flush response (429/400/5xx) before
   * re-queuing the batch. Keeps reporters from hammering the shared per-IP
   * error-ingest rate limit. Defaults to ~2 min; tests pass a tiny value.
   */
  readonly retryDelayMs?: number;
}

export interface BatchPayload {
  readonly app: string;
  readonly version: string;
  readonly reports: ReadonlyArray<ErrorReport>;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_ERROR_ENDPOINT = "https://beam-api.pryx.dev/v1/errors/batch";
const DEFAULT_FLUSH_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_RETRY_DELAY_MS = 120_000;
const MAX_PENDING_BUFFER = 1000;
function readBeamApiKey(): Effect.Effect<string | null, never> {
  return Effect.try({
    try: () => {
      const credentialsFile = join(getBeamUserConfigDir(), "credentials.json");
      if (!existsSync(credentialsFile)) return null;
      const value = JSON.parse(readFileSync(credentialsFile, "utf-8")) as {
        apiKey?: unknown;
      };
      return typeof value.apiKey === "string" && value.apiKey.length > 0 ? value.apiKey : null;
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.catch(() => Effect.succeed(null)));
}

// ─── Sanitization patterns ───────────────────────────────────────────────────
// Base58 chars (no 0/O/I/l): 1-9 A-H J-N P-Z a-k m-z
// Private keys (Solana base58 or EVM hex) are long; we target strings
// >= 64 chars to avoid false-positives on addresses.

const BASE58_LONG_PATTERN = /[1-9A-HJ-NP-Za-km-z]{64,}/g;
const HEX_KEY_PATTERN = /\b0x[0-9a-fA-F]{64,}\b/g;
const RAW_HEX_PATTERN = /\b[0-9a-fA-F]{64,}\b/g;
const SECRET_PATTERN =
  /(?:private[-_]?key|secret[-_]?key|mnemonic|seed[-_]?phrase|secret[-_]?recovery)\s*[:=]\s*[^\s,;"]+/gi;
const PASSWORD_PATTERN = /password\s*[:=]\s*[^\s,;"]+/gi;

function sanitizeMessage(msg: string): string {
  let sanitized = msg;
  sanitized = sanitized.replace(BASE58_LONG_PATTERN, "[REDACTED]");
  sanitized = sanitized.replace(HEX_KEY_PATTERN, "[REDACTED]");
  sanitized = sanitized.replace(RAW_HEX_PATTERN, "[REDACTED]");
  sanitized = sanitized.replace(SECRET_PATTERN, (match) => {
    const keyPart = match.split(/[:=]/)[0] ?? match;
    return `${keyPart}=[REDACTED]`;
  });
  sanitized = sanitized.replace(PASSWORD_PATTERN, (match) => {
    const keyPart = match.split(/[:=]/)[0] ?? match;
    return `${keyPart}=[REDACTED]`;
  });
  return sanitized;
}

function sanitizeStack(stack: string): string {
  return stack
    .split("\n")
    .map((line) => sanitizeMessage(line))
    .join("\n");
}

// ─── Error classification ────────────────────────────────────────────────────

function classifyError(error: Error): ErrorCategory {
  const msg = error.message ?? "";
  const stack = error.stack ?? "";
  const combined = `${msg} ${stack}`.toLowerCase();

  if (combined.includes("bigint") && combined.includes("serializ")) {
    return "ONNX_BigInt";
  }
  if (combined.includes("sqlite") && combined.includes("vec")) {
    return "SQLite_Vec";
  }
  if (combined.includes("rate limit") || combined.includes(" 429 ")) {
    return "RPC_RateLimit";
  }
  if (combined.includes("rpc error") || combined.includes("execution reverted")) {
    return "RPC_Error";
  }
  if (combined.includes("config")) {
    return "Config_Error";
  }
  // Only inspect the error message for update-related keywords; stack traces
  // from test frameworks or Vitest internals (e.g. "updateSnapshot") must not
  // cause unrelated errors to be classified as UpdateFailure.
  const lowerMsg = msg.toLowerCase();
  if (
    lowerMsg.includes("update") ||
    lowerMsg.includes("tarball") ||
    lowerMsg.includes("download")
  ) {
    return "UpdateFailure";
  }

  return "Unknown";
}

// ─── ID generator ────────────────────────────────────────────────────────────

let idCounter = 0;

function generateId(): string {
  idCounter++;
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── ErrorReporter class ─────────────────────────────────────────────────────

export class ErrorReporter {
  private readonly endpoint: string | undefined;
  private readonly enabled: boolean;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly agentId: string;
  private readonly pending: Array<ErrorReport> = [];
  private timerId: ReturnType<typeof setInterval> | null = null;
  private appVersion: string = "0.0.0";
  private _missingCredentialWarned = false;

  constructor(config: ErrorReporterConfig = {}) {
    const explicitEndpoint =
      config.endpoint ??
      (typeof process !== "undefined" ? process.env.BEAM_ERROR_ENDPOINT : undefined);
    const reportingEnv =
      typeof process !== "undefined" ? process.env.BEAM_ERROR_REPORTING : undefined;
    const optOut = config.optOut ?? !readTelemetryPreference().enabled;
    const explicitEnabled = config.enabled ?? reportingEnv !== "false";
    const envDisabled = reportingEnv === "false";
    this.endpoint =
      explicitEndpoint ??
      (explicitEnabled && !envDisabled && !optOut ? DEFAULT_ERROR_ENDPOINT : undefined);
    this.enabled = explicitEnabled && !envDisabled && !optOut;
    this.agentId = config.agentId ?? process.env.BEAM_AGENT_ID ?? "engine";
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    this.flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

    if (this.enabled && this.endpoint) {
      this.timerId = setInterval(() => {
        Effect.runFork(this.flushEffect());
      }, this.flushIntervalMs);
      // Allow the process to exit even if the timer is still active
      if (typeof this.timerId === "object" && this.timerId !== null && "unref" in this.timerId) {
        (this.timerId as NodeJS.Timeout).unref();
      }
    }
  }

  setAppVersion(version: string): void {
    this.appVersion = version;
  }

  report(error: Error, context?: ReportContext): void {
    if (!this.enabled || !this.endpoint) {
      return;
    }

    const category = classifyError(error);
    const sanitizedMessage = sanitizeMessage(error.message);
    const sanitizedStack = error.stack ? sanitizeStack(error.stack) : "";

    const report: ErrorReport = {
      id: generateId(),
      agentId: this.agentId,
      ts: new Date().toISOString(),
      message: sanitizedMessage,
      stack: sanitizedStack,
      category,
      severity: context?.severity ?? "medium",
    };
    if (context?.cycleId !== undefined) Object.assign(report, { cycleId: context.cycleId });
    if (context?.poolAddress !== undefined)
      Object.assign(report, { poolAddress: context.poolAddress });

    if (this.pending.length >= MAX_PENDING_BUFFER) {
      this.pending.shift();
    }
    this.pending.push(report);

    if (this.pending.length >= this.batchSize) {
      Effect.runFork(this.flushEffect());
    }

    console.error(`[ErrorReporter] ${category}: ${sanitizedMessage}`);
  }

  flushEffect(timeoutMs = 10_000): Effect.Effect<void, never> {
    if (!this.enabled || !this.endpoint || this.pending.length === 0) {
      return Effect.void;
    }

    // Cap each flush at `batchSize` — the ingest endpoint rejects batches over
    // a hard limit (50), so sending the entire pending buffer at once (which can
    // grow unbounded while a batch is stuck re-queued) guarantees a permanent
    // 400 → re-queue loop. Splicing only `batchSize` lets the buffer drain and
    // keeps every request under the server cap.
    const batch = this.pending.splice(0, this.batchSize);
    const endpoint = this.endpoint;

    return Effect.gen({ self: this }, function* () {
      const apiKey = yield* readBeamApiKey();
      if (!apiKey && endpoint === DEFAULT_ERROR_ENDPOINT) {
        // Credential-bounded: never send without an API key. Re-queue the
        // batch so reports are not lost, but avoid spamming warnings on
        // every flush when credentials are absent.
        if (!this._missingCredentialWarned) {
          this._missingCredentialWarned = true;
          console.warn("[ErrorReporter] Skipping error report batch: no API key available");
        }
        this.requeueBatch(batch);
        return;
      }
      this._missingCredentialWarned = false;
      const payload: BatchPayload = {
        app: "beam-clmm",
        version: this.appVersion,
        reports: batch,
      };
      const headers = {
        "Content-Type": "application/json",
      };
      if (apiKey) Object.assign(headers, { Authorization: `Bearer ${apiKey}` });
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeoutMs),
          }),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
      if (!response.ok) {
        // 429 (server rate limit: 50 batches/IP/hour on beam-api.pryx.dev) and
        // persistent 400s must NOT re-enter the hot flush loop — instantly
        // re-queuing burns the shared per-IP budget and spams logs every
        // flushInterval. Back off (~2 min default, configurable) so the window
        // resets instead of being hammered.
        const retryMs = this.retryDelayMs + Math.floor(Math.random() * this.retryDelayMs * 0.5);
        console.error(
          `[ErrorReporter] Failed to send batch: ${response.status} ${response.statusText} ` +
            `(${batch.length} reports held, retrying in ${Math.round(retryMs / 1000)}s)`,
        );
        yield* Effect.sleep(retryMs);
        this.requeueBatch(batch);
        return;
      }
    }).pipe(
      Effect.catch((err) =>
        Effect.sync(() => {
          this.requeueBatch(batch);
          console.error("[ErrorReporter] Failed to send error report batch, re-queued:", err);
        }),
      ),
    );
  }

  private requeueBatch(batch: ReadonlyArray<ErrorReport>): void {
    this.pending.unshift(...batch);
    const overflow = this.pending.length - MAX_PENDING_BUFFER;
    if (overflow > 0) {
      this.pending.splice(MAX_PENDING_BUFFER, overflow);
    }
  }

  /**
   * Trigger an async flush and return a Promise that resolves when it
   * completes. Useful for shutdown paths and tests that need to assert
   * the network call happened. Aborts the fetch after `timeoutMs` so a
   * hung endpoint cannot block process exit.
   */
  flushAsync(timeoutMs = 10_000): Promise<void> {
    return Effect.runPromise(this.flushEffect(timeoutMs));
  }

  getPending(): ReadonlyArray<ErrorReport> {
    return [...this.pending];
  }

  disposeEffect(): Effect.Effect<void, never> {
    return Effect.gen({ self: this }, function* () {
      if (this.timerId !== null) {
        clearInterval(this.timerId);
        this.timerId = null;
      }
      yield* this.flushEffect(2_000);
    });
  }

  dispose(): Promise<void> {
    return Effect.runPromise(this.disposeEffect());
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createErrorReporter(config?: ErrorReporterConfig): ErrorReporter {
  return new ErrorReporter(config);
}

// ─── Module-level singleton ──────────────────────────────────────────────────

export const errorReporter: ErrorReporter = new ErrorReporter();
/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-runtime-typeof */
