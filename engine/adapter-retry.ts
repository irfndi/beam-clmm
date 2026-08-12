import { Effect } from "effect";
import { createLogger } from "./logger.js";

const logger = createLogger("adapter-retry");

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- runtime guard over untrusted external error objects at the RPC boundary; Record<string, unknown> is the open-dictionary contract for them
function isObject(err: unknown): err is Record<string, unknown> {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- manual null-object guard on unparsed external error payloads
  return typeof err === "object" && err !== null;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- manual field guard on untrusted RPC error payload at the boundary
function hasCode(err: unknown): err is { readonly code: number } {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- runtime field narrowing while parsing unparsed error payload
  return isObject(err) && "code" in err && typeof err.code === "number";
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- manual field guard on untrusted RPC error payload at the boundary
function hasMessage(err: unknown): err is { readonly message: string } {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- runtime field narrowing while parsing unparsed error payload
  return isObject(err) && "message" in err && typeof err.message === "string";
}

const RETRY_AFTER_MAX_MS = 300_000;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- err is an unparsed external error (Axios/undici/viem shape); guarded via isObject below
export function retryAfterMs(err: unknown): number | undefined {
  if (!isObject(err)) return undefined;
  const headers = err["headers"];
  const response = err["response"];
  const responseHeaders = isObject(response) ? response["headers"] : undefined;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- header value is unparsed external data; narrowed via guards below
  const getHeader = (value: unknown): string | null => {
    if (!isObject(value)) return null;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- runtime guard on unparsed HTTP header object
    if (typeof value["get"] === "function") {
      const result = (value["get"] as (name: string) => unknown)("retry-after");
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- runtime guard on unparsed header value
      if (typeof result === "string") return result;
    }
    const direct = value["retry-after"] ?? value["Retry-After"];
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- runtime guard on unparsed header value
    if (typeof direct === "string") return direct;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- runtime guard on unparsed header value
    if (typeof direct === "number") return String(direct);
    return null;
  };
  const header = getHeader(headers) ?? getHeader(responseHeaders);
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, RETRY_AFTER_MAX_MS);
  }
  const retryAt = Date.parse(header);
  if (Number.isFinite(retryAt)) {
    return Math.min(Math.max(0, retryAt - Date.now()), RETRY_AFTER_MAX_MS);
  }
  return undefined;
}

const retryLogState = new Map<string, { lastLoggedAt: number; suppressed: number }>();
const RETRY_LOG_INTERVAL_MS = 10_000;
const RETRY_LOG_MAX_ENTRIES = 512;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- err is unparsed external error; stringified/guarded below
function errorMessage(err: unknown): string {
  if (hasMessage(err)) return err.message;
  if (isObject(err)) {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err as unknown);
    }
  }
  return String(err);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- err is unparsed external error; delegated to errorMessage guard
export function safeErrorMessage(err: unknown): string {
  return errorMessage(err)
    .replace(/([?&](?:api[-_]?key|token|authorization)=)[^&\s]+/gi, "$1***")
    .replace(/((?:bearer|basic|digest|token)\s+)[^\s]+/gi, "$1***")
    .replace(/\b(x-api-(?:key|token|secret)|x-auth-token)\s*[:=]\s*[^\s,;]+/gi, "$1: ***")
    .replace(/\b(authorization)\s*[:=]\s*[^\r\n]+/gi, "$1: ***")
    .replace(
      /(?<![?&])(["']?(?:api[-_]?key|secret|password|token|authorization)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
      "$1***",
    )
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1***@");
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- err is unparsed external error; keyed via safeErrorMessage
function logRetry(err: unknown, message: string): void {
  const now = Date.now();
  const key = safeErrorMessage(err);
  const previous = retryLogState.get(key);
  if (previous && now - previous.lastLoggedAt < RETRY_LOG_INTERVAL_MS) {
    previous.suppressed++;
    return;
  }
  const suppressed = previous?.suppressed ?? 0;
  if (!previous && retryLogState.size >= RETRY_LOG_MAX_ENTRIES) {
    const oldest = retryLogState.keys().next().value;
    if (oldest !== undefined) retryLogState.delete(oldest);
  }
  retryLogState.set(key, { lastLoggedAt: now, suppressed: 0 });
  const logFields = suppressed > 0 ? { error: key, suppressedRetries: suppressed } : { error: key };
  logger.warn(message, logFields);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- err is unparsed external error; checked via type guards
export function isRetriableError(err: unknown): boolean {
  if (hasCode(err) && (err.code === 429 || err.code === -32005)) return true;
  if (hasMessage(err)) {
    const msg = err.message.toLowerCase();
    if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests")) {
      return true;
    }
    if (msg.includes("rpc request timeout")) return true;
  }
  return false;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- err is unparsed external error; checked via type guards
function isRateLimitError(err: unknown): boolean {
  if (hasCode(err) && (err.code === 429 || err.code === -32005)) return true;
  if (hasMessage(err)) {
    const msg = err.message.toLowerCase();
    return msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests");
  }
  return false;
}

export interface RetryOptions {
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly rateLimitBaseDelayMs?: number;
}

const DEFAULT_RETRY_OPTIONS: Required<Omit<RetryOptions, "rateLimitBaseDelayMs">> & {
  readonly rateLimitBaseDelayMs: number;
} = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  rateLimitBaseDelayMs: 5_000,
};

export function retryEffectWithBackoff<T, E>(
  effect: Effect.Effect<T, E>,
  opts?: RetryOptions,
): Effect.Effect<T, E> {
  const { maxRetries, baseDelayMs, maxDelayMs, rateLimitBaseDelayMs } = {
    ...DEFAULT_RETRY_OPTIONS,
    ...opts,
  };

  const attempt = (attemptNumber: number): Effect.Effect<T, E> =>
    effect.pipe(
      Effect.catch((err) => {
        if (attemptNumber >= maxRetries || !isRetriableError(err)) {
          return Effect.fail(err);
        }
        const effectiveBase = isRateLimitError(err) ? rateLimitBaseDelayMs : baseDelayMs;
        const exponentialDelay = Math.min(maxDelayMs, effectiveBase * 2 ** attemptNumber);
        const jitter = Math.random() * exponentialDelay * 0.5;
        const delay = Math.max(Math.floor(exponentialDelay + jitter), retryAfterMs(err) ?? 0);
        return Effect.sync(() =>
          logRetry(
            err,
            `Retriable RPC error (attempt ${attemptNumber + 1}/${maxRetries}), retrying in ${delay}ms`,
          ),
        ).pipe(
          Effect.andThen(Effect.sleep(delay)),
          Effect.andThen(Effect.suspend(() => attempt(attemptNumber + 1))),
        );
      }),
    );

  return Effect.suspend(() => attempt(0));
}
