import "./load-env.js";
import { runEngine } from "./run-engine.js";

// Guard: Prevent direct execution of engine/index.ts
// Users must use 'beam dev' (CLI) instead
const isDirectExecution =
  process.argv[1]?.endsWith("engine/index.ts") || process.argv[1]?.endsWith("engine/index.js");

if (isDirectExecution && process.env.BEAM_ALLOW_DIRECT !== "true") {
  console.error("Error: Direct execution of engine/index.ts is not allowed.");
  console.error('Please use "beam dev" instead.');
  console.error("");
  console.error("If you need to run the engine directly for development, set:");
  console.error("  BEAM_ALLOW_DIRECT=true bun engine/index.ts");
  process.exit(1);
}

void runEngine();
