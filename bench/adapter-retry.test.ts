import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import {
  retryAfterMs,
  safeErrorMessage,
  isRetriableError,
  retryEffectWithBackoff,
} from "../engine/adapter-retry.js";

describe("retryAfterMs", () => {
  it("returns undefined for non-objects", () => {
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("429")).toBeUndefined();
    expect(retryAfterMs(42)).toBeUndefined();
  });

  it("reads a numeric retry-after header and caps at the max", () => {
    expect(retryAfterMs({ headers: { "retry-after": "5" } })).toBe(5000);
    expect(retryAfterMs({ headers: { "Retry-After": 3 } })).toBe(3000);
    // 400000s * 1000 blows past the 300000ms cap.
    expect(retryAfterMs({ headers: { "retry-after": "400" } })).toBe(300_000);
  });

  it("reads retry-after from a response.headers object with a get() function", () => {
    const headers = { get: (name: string) => (name === "retry-after" ? "7" : null) };
    expect(retryAfterMs({ response: { headers } })).toBe(7000);
  });

  it("parses an HTTP-date retry-after", () => {
    const future = new Date(Date.now() + 2000).toUTCString();
    expect(retryAfterMs({ headers: { "retry-after": future } })).toBeGreaterThan(0);
    expect(retryAfterMs({ headers: { "retry-after": future } })).toBeLessThanOrEqual(300_000);
  });

  it("returns undefined when the header is not a valid delay", () => {
    expect(retryAfterMs({ headers: { "retry-after": "abc" } })).toBeUndefined();
    expect(retryAfterMs({})).toBeUndefined();
  });
});

describe("safeErrorMessage", () => {
  it("redacts api keys, tokens, and bearer credentials", () => {
    expect(safeErrorMessage("api_key=SECRET123&other=1")).not.toContain("SECRET123");
    expect(safeErrorMessage("Bearer abcdefgh123")).not.toContain("abcdefgh123");
    expect(safeErrorMessage("X-Api-Key: topsecret")).not.toContain("topsecret");
    expect(safeErrorMessage("Authorization: Bearer xyz")).not.toContain("xyz");
    expect(safeErrorMessage("https://user:pass@host.com/path")).not.toContain("pass");
  });

  it("keeps an ordinary message intact", () => {
    expect(safeErrorMessage("rate limit exceeded")).toBe("rate limit exceeded");
  });

  it("stringifies objects and non-message errors", () => {
    expect(safeErrorMessage(new Error("boom"))).toBe("boom");
    expect(safeErrorMessage({ code: 429 })).toBe('{"code":429}');
    expect(safeErrorMessage(undefined)).toBe("undefined");
  });
});

describe("isRetriableError", () => {
  it("returns true for rate-limit codes and messages", () => {
    expect(isRetriableError({ code: 429 })).toBe(true);
    expect(isRetriableError({ code: -32005 })).toBe(true);
    expect(isRetriableError(new Error("rate limit exceeded"))).toBe(true);
    expect(isRetriableError(new Error("Too Many Requests"))).toBe(true);
    expect(isRetriableError(new Error("rpc request timeout"))).toBe(true);
  });

  it("returns false for non-retriable errors", () => {
    expect(isRetriableError({ code: 500 })).toBe(false);
    expect(isRetriableError(new Error("insufficient funds"))).toBe(false);
    expect(isRetriableError("just a string")).toBe(false);
  });
});

describe("retryEffectWithBackoff", () => {
  it("succeeds on the first attempt without retrying", async () => {
    let calls = 0;
    const effect = retryEffectWithBackoff(
      Effect.sync(() => {
        calls += 1;
        return "ok";
      }),
      { maxRetries: 3 },
    );
    await expect(Effect.runPromise(effect)).resolves.toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries a retriable failure until it succeeds", async () => {
    let calls = 0;
    const effect = retryEffectWithBackoff(
      Effect.suspend(() => {
        calls += 1;
        return calls < 3
          ? Effect.fail(new Error("rate limit exceeded"))
          : Effect.succeed("recovered");
      }),
      { maxRetries: 5, baseDelayMs: 1, rateLimitBaseDelayMs: 1 },
    );
    await expect(Effect.runPromise(effect)).resolves.toBe("recovered");
    expect(calls).toBe(3);
  });

  it("fails after exhausting retries", async () => {
    let calls = 0;
    const effect = retryEffectWithBackoff(
      Effect.suspend(() => {
        calls += 1;
        return Effect.fail(new Error("rpc request timeout"));
      }),
      { maxRetries: 2, baseDelayMs: 1, rateLimitBaseDelayMs: 1 },
    );
    await expect(Effect.runPromise(effect)).rejects.toThrow();
    expect(calls).toBe(3); // attempt 0 + 2 retries.
  });

  it("does not retry a non-retriable error", async () => {
    let calls = 0;
    const effect = retryEffectWithBackoff(
      Effect.suspend(() => {
        calls += 1;
        return Effect.fail(new Error("insufficient funds"));
      }),
      { maxRetries: 5, baseDelayMs: 1 },
    );
    await expect(Effect.runPromise(effect)).rejects.toThrow("insufficient funds");
    expect(calls).toBe(1);
  });
});