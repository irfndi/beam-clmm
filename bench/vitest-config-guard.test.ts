// Guard + wiring tests for the vitest runtime contract.
//
// Coverage map (clawpatch findings):
// - fnd_sig-feat-test-suite-84ae84a25a-0: `bun --bun vitest run` must actually
//   run under Bun (fail fast outside it) and the config must pin pool/worker
//   semantics instead of silently mixing Node workers in.
// - fnd_sig-feat-test-suite-84ae84a25a-1: the test script must be coupled to
//   typechecking — `pretest` must run `tsc --noEmit` so a green `bun run test`
//   cannot coexist with type errors.
// - fnd_sig-feat-library-334b6b45bc-7e55: `bun run lint` must typecheck the
//   release scripts (scripts/**), not just engine/ops/bench/cli.
//
// FixScripts owns package.json; these tests assert the corrected wiring.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// SAFETY: package.json is repository-controlled and its scripts map is validated by these tests.
const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const vitestConfigSrc = readFileSync(path.join(REPO_ROOT, "vitest.config.ts"), "utf8");

describe("vitest runtime contract", () => {
  it("test scripts run the vitest CLI under Bun via --bun", () => {
    expect(pkg.scripts.test).toMatch(/bun --bun vitest run/);
    expect(pkg.scripts["test:watch"]).toMatch(/bun --bun vitest/);
    expect(pkg.scripts.coverage).toMatch(/bun --bun vitest run --coverage/);
  });

  it("vitest.config.ts fails fast outside Bun with a clear message", () => {
    expect(vitestConfigSrc).toContain('typeof Bun === "undefined"');
    expect(vitestConfigSrc).toContain("throw new Error");
    expect(vitestConfigSrc).toMatch(/require the Bun runtime/);
  });

  it("enforces the Bun-only worker contract (pool pin or fail-fast guard)", () => {
    // Finding 84ae84a25a-0: either pin the Bun worker pool or fail fast
    // outside Bun. The guard (asserted above) satisfies the contract; a pool
    // pin is the alternative shape. Accept either so the fix can choose.
    const hasPoolPin = /pool:\s*["']bun/.test(vitestConfigSrc);
    const hasGuard = vitestConfigSrc.includes('typeof Bun === "undefined"');
    expect(hasPoolPin || hasGuard).toBe(true);
  });

  it("keeps the 75/60/75/75 coverage threshold gate", () => {
    expect(vitestConfigSrc).toMatch(/statements:\s*75/);
    expect(vitestConfigSrc).toMatch(/branches:\s*60/);
    expect(vitestConfigSrc).toMatch(/functions:\s*75/);
    expect(vitestConfigSrc).toMatch(/lines:\s*75/);
  });
});

describe("test/typecheck coupling", () => {
  it("runs tsc --noEmit before tests (pretest) so test can never pass on broken types", () => {
    expect(pkg.scripts.pretest).toMatch(/tsc --noEmit/);
  });

  it("keeps tsc --noEmit in the lint pipeline (scripts/lint.sh)", () => {
    const lintSh = readFileSync(path.join(REPO_ROOT, "scripts", "lint.sh"), "utf8");
    expect(pkg.scripts.lint).toContain("scripts/lint.sh");
    expect(lintSh).toContain("tsc --noEmit");
  });

  it("lint typechecks the release scripts (scripts/** in the tsc include)", () => {
    // tsconfig.json carries JSON comments, so scan the raw text instead of
    // JSON.parse. Finding 7e55: scripts/*.ts are release tooling and must be
    // covered by the tsc --noEmit gate.
    const tsconfigSrc = readFileSync(path.join(REPO_ROOT, "tsconfig.json"), "utf8");
    const includeMatch = tsconfigSrc.match(/"include"\s*:\s*\[([^\]]*)\]/);
    const includeList = includeMatch?.[1];
    expect(includeList).toBeDefined();
    expect(includeList).toContain('"scripts/**/*"');
  });
});
