import { Effect, Layer } from "effect";
import { MemoryService, type MemoryApi } from "./services.js";
import { DbService } from "./services.js";

export const MemoryLive = Layer.effect(
  MemoryService,
  Effect.gen(function* () {
    const db = yield* DbService;

    const api: MemoryApi = {
      initialize: () => Effect.void,

      upsert: (entry) =>
        Effect.gen(function* () {
          const content = entry.content ?? `${entry.category} entry`;
          yield* db.insertMemory({
            content,
            category: entry.category,
            poolAddress: entry.poolAddress,
            outcome: entry.outcome,
            pnlUsd: entry.pnlUsd,
            confidence: entry.confidence,
          });
        }),

      getRelevantContext: (query, topK = 5, poolAddress) =>
        db.queryMemory(query, topK, poolAddress),

      pruneExpired: () => db.pruneMemory(),

      recordOutcome: (poolAddress, action, pnlUsd, context) =>
        Effect.gen(function* () {
          const outcome = pnlUsd > 0 ? "profit" : pnlUsd < 0 ? "loss" : "neutral";
          const content = `${action} on ${poolAddress}: PnL=$${pnlUsd.toFixed(2)}. Context: ${context}`;
          yield* db.insertMemory({
            content,
            category: "outcome",
            poolAddress,
            outcome,
            pnlUsd,
          });
        }),
    };

    return api;
  }),
);
