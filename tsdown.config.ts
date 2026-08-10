import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["engine/index.ts"],
  format: ["esm"],
  target: "node26",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  deps: {
    neverBundle: ["bun:sqlite"],
  },
  // dist/ is consumed by scripts/build-bundle.ts (staged into the release
  // tarball) and by tsdown.cli.config.ts for the CLI bundle — it is not a
  // standalone artifact. Release bundles ship without node_modules and bare
  // imports resolve from bun's global cache — which broke v0.1.9 (issue
  // #179). Bundle every runtime dependency; @xenova/transformers stays
  // external (optional ONNX backend, import failure falls back to hash
  // vectors). viem and the @uniswap SDKs are the core EVM runtime and must
  // be bundled for the same reason.
  noExternal: [
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
});
