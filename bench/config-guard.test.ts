// Guards the behaviors vitest.config.ts hard-codes:
//  - the Bun-runtime guard (the only thing preventing cryptic Node failures),
//  - test.include restricted to bench/**/*.test.ts (overrides Vitest discovery,
//    so a test added outside bench/ is silently never run),
//  - the 75/60/75/75 coverage thresholds,
//  - every coverage.exclude path resolving to a real file (stale exclusions
//    silently keep deleted modules off the gate forever),
//  - the program.ts / adapter-service.ts carve-outs staying bound to a dated
//    review instead of rotting into permanent exclusions.
//
// A one-line change (include typo, guard removal, threshold drift) fails here.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Loads the real config under Bun — this import throws at load time if the
// Bun guard ever regresses into throwing on the actual test runtime.
import beamConfig from "../vitest.config.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_SRC = readFileSync(path.join(REPO_ROOT, "vitest.config.ts"), "utf8");
const TEST = beamConfig.test!;
const COVERAGE = TEST.coverage!;

describe("vitest.config.ts guard", () => {
  it("fails fast with a clear message when not running under Bun", () => {
    expect(CONFIG_SRC).toContain('typeof Bun === "undefined"');
    expect(CONFIG_SRC).toContain('throw new Error("Beam tests require the Bun runtime.');
  });

  it("discovers every test under bench/** (include pattern covers the repo)", () => {
    expect(TEST.include).toContain("bench/**/*.test.ts");
    // Vitest reports only the tests it found; assert the pattern still
    // matches the directory the suite actually lives in.
    const benchFiles = readdirSync(path.join(REPO_ROOT, "bench"));
    expect(benchFiles.some((f) => f.endsWith(".test.ts"))).toBe(true);
  });

  it("enforces the 75/60/75/75 coverage thresholds", () => {
    expect(COVERAGE.thresholds).toEqual({
      statements: 75,
      branches: 60,
      functions: 75,
      lines: 75,
    });
  });

  it("every coverage.exclude path resolves to an existing file", () => {
    for (const rel of COVERAGE.exclude!) {
      expect(
        existsSync(path.join(REPO_ROOT, rel)),
        `coverage.exclude references missing file: ${rel}`,
      ).toBe(true);
    }
  });

  it("program.ts / adapter-service.ts carve-outs are bound to a dated review", () => {
    const exclude = COVERAGE.exclude!;
    expect(exclude).toContain("engine/program.ts");
    expect(exclude).toContain("engine/adapter-service.ts");
    // The carve-out must be re-justified on a dated review, not permanent:
    // fail if the comment loses its review date or the measured numbers.
    const commentStart = CONFIG_SRC.indexOf("// Measured 2026-08-10");
    expect(commentStart).toBeGreaterThan(-1);
    const commentBlock = CONFIG_SRC.slice(commentStart, CONFIG_SRC.indexOf("engine/program.ts"));
    expect(commentBlock).toMatch(/Measured 2026-08-10/);
    expect(commentBlock).toMatch(/REVIEW DATE: 2026-08-10/);
  });
});
