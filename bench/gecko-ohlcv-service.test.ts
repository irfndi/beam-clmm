import { describe, it, expect } from "vitest";
import {
  parseGeckoOhlcv,
  summarizeGeckoOhlcv,
  getGeckoPoolOhlcv,
  DEFAULT_OHLCV_LIMIT,
  type GeckoOhlcvBar,
} from "../engine/gecko-ohlcv-service.js";

function bar(ts: number, close: number, opts: Partial<GeckoOhlcvBar> = {}): GeckoOhlcvBar {
  return { timestampSec: ts, open: close, high: close, low: close, close, volumeQuote: 0, ...opts };
}

// ─── parseGeckoOhlcv ──────────────────────────────────────────────────────────

describe("parseGeckoOhlcv", () => {
  type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { readonly [key: string]: JsonValue };
  const payload = (list: JsonValue) => ({
    data: { attributes: { ohlcv_list: list } },
  });

  it("parses a valid newest-first ohlcv_list into bars", () => {
    const bars = parseGeckoOhlcv(
      payload([
        [3, "10", "12", "9", "11", "500"],
        [2, 8, 9, 7, 8, 100],
        [1, 5, 6, 4, 5, 50],
      ]),
    );
    expect(bars).toHaveLength(3);
    expect(bars[0]).toEqual({
      timestampSec: 3,
      open: 10,
      high: 12,
      low: 9,
      close: 11,
      volumeQuote: 500,
    });
  });

  it("returns [] for non-object / missing data / missing attributes / non-array list", () => {
    expect(parseGeckoOhlcv(null)).toEqual([]);
    expect(parseGeckoOhlcv("nope")).toEqual([]);
    expect(parseGeckoOhlcv({})).toEqual([]);
    expect(parseGeckoOhlcv({ data: null })).toEqual([]);
    expect(parseGeckoOhlcv({ data: { attributes: null } })).toEqual([]);
    expect(parseGeckoOhlcv({ data: { attributes: { ohlcv_list: "x" } } })).toEqual([]);
  });

  it("skips entries shorter than 5 fields", () => {
    expect(parseGeckoOhlcv(payload([[1, 2, 3, 4]]))).toEqual([]);
  });

  it("skips entries with non-finite or missing numbers", () => {
    const bars = parseGeckoOhlcv(
      payload([
        [null, 2, 3, 4, 5], // bad timestamp
        [1, "bad", 3, 4, 5], // bad open
        [1, 2, 3, 4, Number.NaN], // bad close
        [1, 2, 3, 4, 5],
      ]),
    );
    expect(bars).toHaveLength(1);
  });

  it("drops bars with a non-positive close (dead/corrupt candle)", () => {
    const bars = parseGeckoOhlcv(
      payload([
        [1, 2, 3, 4, 0],
        [2, 2, 3, 4, -1],
        [3, 2, 3, 4, 5],
      ]),
    );
    expect(bars).toHaveLength(1);
    expect(bars[0]!.timestampSec).toBe(3);
  });

  it("defaults a missing volume to 0 but keeps the bar", () => {
    const bars = parseGeckoOhlcv(payload([[1, 2, 3, 4, 5]]));
    expect(bars[0]!.volumeQuote).toBe(0);
  });
});

// ─── summarizeGeckoOhlcv ──────────────────────────────────────────────────────

describe("summarizeGeckoOhlcv", () => {
  it("returns zeroed signals for an empty series", () => {
    const s = summarizeGeckoOhlcv([]);
    expect(s.atlHigh).toBe(0);
    expect(s.latestClose).toBe(0);
    expect(s.drawdownFromAth).toBe(0);
    expect(s.dailyReturnStddev).toBe(0);
    expect(s.totalVolumeQuote).toBe(0);
    expect(s.barCount).toBe(0);
  });

  it("normalizes newest-first input to ascending order for drawdown and latest close", () => {
    // ATH high = 120 at the earliest bar; latest close = 90 → drawdown 25%.
    const bars = [
      bar(3, 90, { high: 100 }), // newest
      bar(2, 100, { high: 110 }),
      bar(1, 110, { high: 120 }), // oldest, ATH
    ];
    const s = summarizeGeckoOhlcv(bars);
    expect(s.atlHigh).toBe(120);
    expect(s.latestClose).toBe(90);
    expect(s.drawdownFromAth).toBeCloseTo(0.25, 8);
    expect(s.barCount).toBe(3);
  });

  it("computes positive daily log-return stddev across consecutive closes", () => {
    // Closes 100 → 100 → 100 → 100 → 100: all log returns 0 → stddev 0.
    const flat = Array.from({ length: 5 }, (_, i) => bar(i + 1, 100));
    expect(summarizeGeckoOhlcv(flat).dailyReturnStddev).toBe(0);

    // Closes 100 → 110 → 132: log returns ln(1.1), ln(1.2) → positive stddev.
    const up = [bar(1, 100), bar(2, 110), bar(3, 132)];
    const s = summarizeGeckoOhlcv(up);
    expect(s.dailyReturnStddev).toBeGreaterThan(0);
  });

  it("returns stddev 0 when fewer than 2 usable log returns exist", () => {
    expect(summarizeGeckoOhlcv([bar(1, 100)]).dailyReturnStddev).toBe(0);
    // Two bars → only 1 log return → stddev stays 0.
    expect(summarizeGeckoOhlcv([bar(1, 100), bar(2, 110)]).dailyReturnStddev).toBe(0);
  });

  it("skips non-positive closes when computing log returns", () => {
    // bar(2, 0) is dropped from log-return math but still counted in barCount.
    const bars = [bar(1, 100), bar(2, 0), bar(3, 110)];
    const s = summarizeGeckoOhlcv(bars);
    expect(s.barCount).toBe(3);
    expect(s.dailyReturnStddev).toBe(0);
  });

  it("sums total volume quote", () => {
    const s = summarizeGeckoOhlcv([
      bar(1, 100, { volumeQuote: 10 }),
      bar(2, 110, { volumeQuote: 20 }),
    ]);
    expect(s.totalVolumeQuote).toBe(30);
  });

  it("returns drawdown 0 when ATH is not positive", () => {
    // All negative highs → drawdown clamps to 0.
    const s = summarizeGeckoOhlcv([bar(1, -5, { high: -1 }), bar(2, 5, { high: 5 })]);
    expect(s.atlHigh).toBe(5);
    expect(s.drawdownFromAth).toBe(0);
  });
});

// ─── getGeckoPoolOhlcv ────────────────────────────────────────────────────────

describe("getGeckoPoolOhlcv", () => {
  const okBody = {
    data: {
      attributes: {
        ohlcv_list: [
          [1, 10, 12, 9, 11, 500],
          [2, 11, 12, 10, 12, 600],
        ],
      },
    },
  };

  it("fetches, parses and summarizes a series on success", async () => {
    const fetchImpl = async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json(okBody);
    const signals = await getGeckoPoolOhlcv("pool-ok", { fetchImpl, cacheTtlMs: 0 });
    expect(signals).not.toBeNull();
    expect(signals!.barCount).toBe(2);
    expect(signals!.latestClose).toBe(12);
  });

  it("returns null on a non-ok HTTP status", async () => {
    const fetchImpl = async () => new Response("nf", { status: 404 });
    const signals = await getGeckoPoolOhlcv("pool-404", { fetchImpl });
    expect(signals).toBeNull();
  });

  it("returns null when the payload has no usable bars", async () => {
    const fetchImpl = async () => Response.json({ data: { attributes: { ohlcv_list: [] } } });
    const signals = await getGeckoPoolOhlcv("pool-empty", { fetchImpl });
    expect(signals).toBeNull();
  });

  it("returns null when the fetch throws", async () => {
    const fetchImpl = async () => {
      throw new Error("network down");
    };
    const signals = await getGeckoPoolOhlcv("pool-throw", { fetchImpl });
    expect(signals).toBeNull();
  });

  it("serves a fresh series from the last-good cache", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return Response.json(okBody);
    };
    const first = await getGeckoPoolOhlcv("pool-cache", { fetchImpl, cacheTtlMs: 60_000 });
    expect(first).not.toBeNull();
    const second = await getGeckoPoolOhlcv("pool-cache", { fetchImpl, cacheTtlMs: 60_000 });
    expect(second).not.toBeNull();
    expect(calls).toBe(1); // second call served from cache
  });

  it("reuses the stale last-good series during a backoff window after a failure", async () => {
    const fetchImpl = async () => Response.json(okBody);
    const first = await getGeckoPoolOhlcv("pool-backoff", {
      fetchImpl,
      cacheTtlMs: 0, // force a re-fetch path on the next call
    });
    expect(first).not.toBeNull();

    // Now the endpoint fails; the backoff window should serve the stale series.
    const failing = async () => new Response("boom", { status: 500 });
    const second = await getGeckoPoolOhlcv("pool-backoff", { fetchImpl: failing, cacheTtlMs: 0 });
    expect(second).not.toBeNull(); // stale last-good reused
    expect(second!.barCount).toBe(2);
  });

  it("returns null for a failing pool with no history", async () => {
    const failing = async () => new Response("boom", { status: 500 });
    const signals = await getGeckoPoolOhlcv("pool-nohistory", { fetchImpl: failing });
    expect(signals).toBeNull();
  });

  it("honors the limit query parameter", async () => {
    let seenUrl = "";
    const fetchImpl = async (input: string | URL | Request) => {
      seenUrl = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
      return Response.json(okBody);
    };
    await getGeckoPoolOhlcv("pool-limit", { fetchImpl, limit: 30 });
    expect(seenUrl).toContain(`ohlcv/day?limit=30`);
  });

  it("uses the default OHLCV limit when none is supplied", async () => {
    expect(DEFAULT_OHLCV_LIMIT).toBe(180);
  });
});
