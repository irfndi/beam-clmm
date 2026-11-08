/**
 * decision-service.ts — the decision core as an Effect Layer.
 *
 * The core itself stays pure (`runDecisionShadow`, `decide`) because pure
 * functions are trivially testable and replayable. This layer is the single
 * point where the program obtains it, so the wiring is an ordinary Effect
 * dependency: injectable in tests, swappable for a replay implementation, and
 * composable with the rest of the engine's Layers.
 */

import { Effect, Layer } from "effect";
import { DecisionService, type DecisionApi } from "./services.js";
import { runDecisionShadow } from "./decision-shadow.js";
import { decide } from "./core/decide.js";

const api: DecisionApi = {
  decide: (input) => Effect.sync(() => decide(input)),
  shadow: (input) => Effect.sync(() => runDecisionShadow(input)),
};

export const DecisionLive = Layer.succeed(DecisionService, DecisionService.of(api));
