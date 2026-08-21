import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["cli/index.ts"],
  format: ["esm"],
  target: "node26",
  outDir: "dist/cli",
  clean: true,
  sourcemap: true,
  dts: false,
  deps: {
    neverBundle: ["bun:sqlite"],
    onlyBundle: false,
    alwaysBundle: [
      "sqlite-vec",
      "effect",
      "commander",
      "chalk",
      "dotenv",
      "@clack/prompts",
      "semver",
      "viem",
      "@uniswap/sdk-core",
      "@uniswap/v3-sdk",
      "@uniswap/v4-sdk",
    ],
  },
  // Release bundles ship without node_modules and the runtime resolves bare
  // imports from bun's global cache — which can hold the WRONG effect major
  // (issue #179: v0.1.9 bundle called Context.Service against cached effect 3).
  // Bundle every runtime dependency so the artifact is version-consistent and
  // self-contained. @xenova/transformers stays external: it is only loaded for
  // the optional ONNX embeddings backend and its import failure is already
  // caught with a fallback to hash vectors. viem and the @uniswap SDKs are
  // the core EVM runtime and must be bundled for the same reason.
});
