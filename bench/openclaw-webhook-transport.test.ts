import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { OpenClawWebhookTransport } from "../engine/openclaw-webhook-transport.js";
import type { AgentRuntimeContext } from "../engine/agent-transport.js";
import type { AgentDecision, PoolState, PoolMetrics, MemoryEntry } from "../engine/types.js";
import type { DecisionRecord } from "../engine/services.js";

function makeContext(): AgentRuntimeContext {
  const decision: AgentDecision = {
    action: "HOLD",
    poolAddress: "Pool111111111111111111111111111111111111111",
    confidence: 0.65,
    reasoning: "test decision",
  };

  const pool: PoolState = {
    address: decision.poolAddress,
    tokenX: "SOL",
    tokenY: "USDC",
    tokenXSymbol: "SOL",
    tokenYSymbol: "USDC",
    tvlUsd: 100_000,
    volume24hUsd: 30_000,
    fees24hUsd: 300,
    apr: 60,
    activeBinId: 5000,
    binStep: 10,
    currentPrice: 150,
    timestamp: Date.now(),
  };

  const metrics: PoolMetrics = {
    pool,
    binArray: {
      lowerBinId: 4900,
      upperBinId: 5100,
      bins: [],
      activeBinId: 5000,
      binStep: 10,
    },
    tvlVelocity: 0,
    feeIlRatio: 1.5,
    volumeAuthenticity: 0.9,
    binUtilization: 0.5,
    volumeAuthenticityKnown: true,
    feeIlRatioKnown: true,
    farmAprPct: null,
    binUtilizationKnown: true,
  };

  const warnings: MemoryEntry[] = [];
  const recentDecisions: DecisionRecord[] = [];

  return { decision, pool, metrics, warnings, recentDecisions, hasOpenPosition: false };
}

describe("OpenClawWebhookTransport", () => {
  it("includes the prompt in the webhook payload", async () => {
    type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
    type JsonObject = { readonly [key: string]: JsonValue };
    let capturedBody: JsonObject | null = null;

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        // SAFETY: this local server receives the transport's JSON object payload.
        capturedBody = (await request.json()) as JsonObject;
        return Response.json({ action: "HOLD", confidence: 0.65, reasoning: "ok" });
      },
    });

    try {
      const transport = new OpenClawWebhookTransport({
        url: `http://127.0.0.1:${server.port}/hooks/agent`,
        timeoutMs: 5000,
      });

      const prompt = "Respond with the proposal JSON schema";
      const response = await Effect.runPromise(transport.sendPrompt(prompt, makeContext()));

      expect(response.raw).toBeDefined();
      expect(capturedBody).toMatchObject({
        type: "beam_prompt",
        prompt,
      });
      // SAFETY: the local server assigns the validated webhook JSON object before this assertion.
      const body = capturedBody!;
      expect(body.decision).toBeDefined();
      expect(body.pool).toBeDefined();
    } finally {
      void server.stop();
    }
  });
});
