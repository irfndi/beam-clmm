// Bundle-config contract tests for the release build (tsdown).
//
// Coverage map (clawpatch findings):
// - fnd_sig-feat-library-334b6b45bc-87fc: noExternal must bundle the core EVM
//   runtime deps (viem + @uniswap SDKs) or the v0.1.9 broken-bundle incident
//   (#179: runtime deps resolved from bun's global cache) repeats.
// - fnd_sig-feat-library-334b6b45bc-8059: the `bigint-buffer` alias targeted
//   node_modules/bigint-buffer/dist/browser.js but the package is not declared
//   in package.json (phantom dependency). No source imports bigint-buffer, so
//   the alias must be removed — the config must not reference a module that
//   package.json does not declare.
//
// FixScripts owns tsdown.config.ts / tsdown.cli.config.ts and package.json;
// these tests assert the corrected config.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};
const engineConfig = readFileSync(path.join(REPO_ROOT, "tsdown.config.ts"), "utf8");
const cliConfig = readFileSync(path.join(REPO_ROOT, "tsdown.cli.config.ts"), "utf8");
const configs = [
  { name: "tsdown.config.ts", src: engineConfig },
  { name: "tsdown.cli.config.ts", src: cliConfig },
];

describe("tsdown release-bundle config", () => {
  const evmRuntimeDeps = ["viem", "@uniswap/sdk-core", "@uniswap/v3-sdk", "@uniswap/v4-sdk"];

  it.each(configs)("$name bundles every EVM runtime dependency via noExternal", ({ src }) => {
    const noExternalBlock = src.slice(src.indexOf("noExternal:"));
    for (const dep of evmRuntimeDeps) {
      expect(noExternalBlock).toContain(`"${dep}"`);
    }
  });

  it.each(configs)(
    "$name does not alias bigint-buffer (phantom dep, no source imports it)",
    ({ src }) => {
      expect(src).not.toMatch(/"bigint-buffer"\s*:/);
    },
  );

  it("bigint-buffer is not declared in package.json dependencies", () => {
    expect(pkg.dependencies["bigint-buffer"]).toBeUndefined();
  });

  it("no config aliases a module absent from package.json dependencies", () => {
    // Every alias key must be a declared dependency — otherwise the alias is a
    // phantom dependency that breaks as soon as hoisting changes.
    for (const { src } of configs) {
      const aliasMatch = src.match(/alias:\s*\{([\s\S]*?)\}/);
      if (!aliasMatch) continue;
      const keys = [...aliasMatch[1]!.matchAll(/"([^"]+)":/g)].map((m) => m[1]!);
      for (const key of keys) {
        expect(pkg.dependencies[key], `alias "${key}" must be a declared dependency`).toBeDefined();
      }
    }
  });

  it("keeps @xenova/transformers external (optional ONNX backend, #179 exception)", () => {
    // The v0.1.9 fix (#179) bundles every runtime dep EXCEPT the optional
    // ONNX backend; adding it back to noExternal silently reverts that
    // decision (its import failure is the fallback path to hash vectors).
    for (const { src } of configs) {
      const noExternal = src.slice(src.indexOf("noExternal:"));
      expect(noExternal).not.toContain('"@xenova/transformers"');
      expect(src).toContain("@xenova/transformers"); // documented as external
    }
  });
});
