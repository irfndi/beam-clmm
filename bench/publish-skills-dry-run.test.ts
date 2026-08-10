// Contract tests for scripts/publish-skills.sh (--dry-run safety + real-mode
// build ordering). The script is executed against an ISOLATED COPY of the repo
// directories it touches (scripts/, mcp-server/, packages/*, package.json) so
// the tests can create dist fixtures without mutating the real tree, with
// stub npm/python3/node/twine on PATH that log every invocation.
//
// Coverage map (clawpatch findings):
// - fnd_sig-feat-config-0610d665b5-ab909: extra/unknown args exit 2; dry-run
//   never invokes the publish tools.
// - fnd_sig-feat-config-0610d665b5-7d2a4: dry-run on a tree with no dist/
//   must exit 0 (no empty-dist abort when the build is skipped).
// - fnd_sig-feat-config-0610d665b5-8dfaf: every "published" success claim is
//   qualified with the [DRY-RUN] prefix in dry-run mode.
// - fnd_sig-feat-config-0610d665b5-b81eb: real mode ALWAYS rebuilds, even
//   when a stale dist artifact already exists, and publishes in order
//   npm -> twine langchain-beam -> twine autogpt-beam.
//
// FixScripts owns the script; these tests assert the corrected behavior.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let sandbox: string;
let stubDir: string;
let stubLog: string;

function writeStub(name: string, body: string): void {
  writeFileSync(path.join(stubDir, name), `#!/usr/bin/env bash\n${body}`, { mode: 0o755 });
}

beforeAll(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "publish-skills-test-"));
  stubDir = path.join(sandbox, "bin");
  stubLog = path.join(sandbox, "stub.log");
  mkdirSync(stubDir);

  // Isolated copy of everything the script touches at runtime.
  cpSync(path.join(REPO_ROOT, "scripts"), path.join(sandbox, "scripts"), { recursive: true });
  cpSync(path.join(REPO_ROOT, "mcp-server"), path.join(sandbox, "mcp-server"), { recursive: true });
  cpSync(path.join(REPO_ROOT, "packages"), path.join(sandbox, "packages"), { recursive: true });
  cpSync(path.join(REPO_ROOT, "package.json"), path.join(sandbox, "package.json"));

  writeStub("npm", `{ echo "npm $*"; } >> "$STUB_LOG"\nexit 0\n`);
  writeStub(
    "python3",
    [
      // Preflight probes are not publish actions — do not log them.
      'if [ "$1" = "-m" ] && [ "$2" = "build" ] && [ "$3" = "--version" ]; then exit 0; fi',
      'if [ "$1" = "-m" ] && [ "$2" = "twine" ] && [ "$3" = "--version" ]; then exit 0; fi',
      '{ echo "python3 $*"; } >> "$STUB_LOG"',
      "exit 0",
    ].join("\n") + "\n",
  );
  writeStub("node", `echo "0.1.11"\n`);
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runScript(args: string[]): RunResult {
  try {
    const stdout = execFileSync("bash", ["scripts/publish-skills.sh", ...args], {
      cwd: sandbox,
      env: { ...(process.env as Record<string, string>), PATH: `${stubDir}:${process.env.PATH}`, STUB_LOG: stubLog },
      encoding: "utf8",
      timeout: 60_000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      status: e.status ?? 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
    };
  }
}

function resetLog(): void {
  writeFileSync(stubLog, "");
}

function logLines(): string[] {
  return readFileSync(stubLog, "utf8").trim().split("\n").filter(Boolean);
}

function assertDryRunOutputQualified(output: string): void {
  const lines = output.split("\n");
  for (const line of lines) {
    if (line.includes("published.") && !line.includes("All packages")) {
      expect(line, `unqualified success claim in dry-run: ${line}`).toContain("[DRY-RUN]");
    }
  }
  expect(output).not.toContain("aborting");
}

describe("scripts/publish-skills.sh", () => {
  it("rejects extra arguments with exit 2 (dry-run can never flip to real mode)", () => {
    resetLog();
    const res = runScript(["--dry-run", "extra"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("extra arguments");
    expect(logLines()).toEqual([]);
  });

  it("rejects unknown arguments with exit 2", () => {
    resetLog();
    const res = runScript(["--bogus"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("unknown argument");
    expect(logLines()).toEqual([]);
  });

  it("dry-run on a fresh checkout (no dist/ anywhere) exits 0 and invokes nothing", () => {
    resetLog();
    const res = runScript(["--dry-run"]);
    expect(res.status).toBe(0);
    assertDryRunOutputQualified(res.stdout + res.stderr);
    expect(logLines()).toEqual([]);
  });

  it("dry-run with existing dist artifacts still invokes nothing and prefixes all success claims", () => {
    mkdirSync(path.join(sandbox, "mcp-server", "dist"), { recursive: true });
    writeFileSync(path.join(sandbox, "mcp-server", "dist", "index.js"), "// fixture\n");
    for (const pkgDir of ["langchain-beam", "autogpt-beam"]) {
      const dist = path.join(sandbox, "packages", pkgDir, "dist");
      mkdirSync(dist, { recursive: true });
      writeFileSync(path.join(dist, `${pkgDir}-0.1.0-py3-none-any.whl`), "fixture");
    }
    resetLog();
    const res = runScript(["--dry-run"]);
    expect(res.status).toBe(0);
    assertDryRunOutputQualified(res.stdout + res.stderr);
    expect(logLines()).toEqual([]);
  });

  it("real mode with no dist runs the build and aborts on the empty dist", () => {
    // The dry-run-with-artifacts test above left fixture dists in the copy;
    // this test needs the fresh-checkout shape, so remove them first.
    rmSync(path.join(sandbox, "mcp-server", "dist"), { recursive: true, force: true });
    for (const pkgDir of ["langchain-beam", "autogpt-beam"]) {
      rmSync(path.join(sandbox, "packages", pkgDir, "dist"), { recursive: true, force: true });
    }
    resetLog();
    const res = runScript([]);
    expect(logLines()).toContain("npm run build");
    expect(logLines()).toContain("npm publish --access public");
    expect(logLines()).toContain("python3 -m build");
    // Empty dist after build aborts in real mode (nothing to upload) — the
    // fail-fast is correct here; only dry-run must not abort.
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toContain("dist is empty");
  });

  it("real mode ALWAYS rebuilds when stale dist artifacts exist (b81eb)", () => {
    // Recreate the stale fixtures the previous test removed: dist/index.js +
    // whls whose build commands the old skip-if-artifact-exists logic would
    // have skipped.
    mkdirSync(path.join(sandbox, "mcp-server", "dist"), { recursive: true });
    writeFileSync(path.join(sandbox, "mcp-server", "dist", "index.js"), "// fixture\n");
    for (const pkgDir of ["langchain-beam", "autogpt-beam"]) {
      const dist = path.join(sandbox, "packages", pkgDir, "dist");
      mkdirSync(dist, { recursive: true });
      writeFileSync(path.join(dist, `${pkgDir}-0.1.0-py3-none-any.whl`), "fixture");
    }
    resetLog();
    const res = runScript([]);
    expect(logLines()).toContain("npm run build");
    expect(logLines()).toContain("python3 -m build");
    expect(res.status).toBe(0);
  });

  it("real mode publishes in order: npm, then langchain-beam, then autogpt-beam", () => {
    resetLog();
    runScript([]);
    const log = logLines();
    const npmPublish = log.findIndex((l) => l === "npm publish --access public");
    const langchainTwine = log.findIndex(
      (l) => l.startsWith("python3 -m twine upload") && l.includes("langchain-beam"),
    );
    const autogptTwine = log.findIndex(
      (l) => l.startsWith("python3 -m twine upload") && l.includes("autogpt-beam"),
    );
    expect(npmPublish).toBeGreaterThan(-1);
    expect(langchainTwine).toBeGreaterThan(npmPublish);
    expect(autogptTwine).toBeGreaterThan(langchainTwine);
  });
});
