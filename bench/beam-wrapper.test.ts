// Contract tests for scripts/beam.sh (the `beam` bin wrapper).
//
// Coverage map (clawpatch findings):
// - fnd_sig-feat-library-334b6b45bc-c771: the prerelease version comparator
//   must order semver numerically (canary.10 > canary.2), not lexicographically.
// - Version gate: the wrapper must fail with an actionable message when bun is
//   missing or older than engines.bun (>= 1.4.0-canary.1).
// - Symlink resolution: the wrapper must resolve the package root through
//   `bin`-style symlinks so BEAM_INSTALL_DIR / cli/index.ts are correct even
//   when invoked via a global bin link.
//
// The wrapper is executed as a real subprocess with a stub `bun` on PATH, so
// the tests exercise the actual script, not a copy of its logic.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BEAM_SH = path.join(REPO_ROOT, "scripts", "beam.sh");
const MIN_BUN_VERSION = "1.4.0-canary.1";

let sandbox: string;
let stubDir: string;
let stubLog: string;
let noHomeDir: string;

beforeAll(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "beam-wrapper-test-"));
  stubDir = path.join(sandbox, "bin");
  mkdirSync(stubDir);
  stubLog = path.join(sandbox, "stub.log");
  noHomeDir = path.join(sandbox, "nohome");
  mkdirSync(noHomeDir);

  // Fake `bun`: prints FAKE_BUN_VERSION for --version, otherwise logs the
  // exec'd command line plus the BEAM_* env the wrapper exports.
  const bunStub = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  printf '%s\\n' "$FAKE_BUN_VERSION"
  exit 0
fi
{
  echo "EXEC:$*"
  env | grep '^BEAM_' || true
} >> "$STUB_LOG"
exit 0
`;
  writeFileSync(path.join(stubDir, "bun"), bunStub, { mode: 0o755 });
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// The stub log accumulates across tests; each test asserts on its own run.
beforeEach(() => {
  writeFileSync(stubLog, "");
});

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runBeam(
  args: string[],
  opts: { version?: string; home?: string; path?: string; cwd?: string; script?: string } = {},
): RunResult {
  // SAFETY: process.env is copied into a child-process environment whose values are strings.
  const env = {
    ...(process.env as Record<string, string>),
    FAKE_BUN_VERSION: opts.version ?? MIN_BUN_VERSION,
    STUB_LOG: stubLog,
    PATH: opts.path ?? `${stubDir}:/usr/bin:/bin`,
    HOME: opts.home ?? sandbox,
  } satisfies Record<string, string>;
  const script = opts.script ?? BEAM_SH;
  try {
    const stdout = execFileSync("bash", [script, ...args], {
      cwd: opts.cwd,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    // SAFETY: execFileSync errors expose these documented subprocess fields.
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      status: e.status ?? 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
    };
  }
}

function logLines(): string[] {
  if (!existsSync(stubLog)) return [];
  return readFileSync(stubLog, "utf8").trim().split("\n").filter(Boolean);
}

describe("scripts/beam.sh wrapper", () => {
  it("exits 1 with an actionable message when bun is older than engines.bun", () => {
    const res = runBeam(["--help"], { version: "1.3.9" });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("too old");
    expect(res.stderr).toContain(MIN_BUN_VERSION);
  });

  it("exits 1 when bun --version produces no output", () => {
    const res = runBeam(["--help"], { version: "" });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("could not determine bun version");
  });

  it("exits 1 with an actionable message when bun is not on PATH or in ~/.bun/bin", () => {
    const res = runBeam(["--help"], {
      path: "/usr/bin:/bin", // no stub dir: `command -v bun` fails
      home: noHomeDir, // and no ~/.bun/bin/bun
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("bun not found");
  });

  it.each([
    ["1.4.0-canary.1", "minimum prerelease"],
    ["1.4.0", "stable release"],
    ["2.0.0", "newer major"],
  ])("passes the version gate for %s (%s) and execs the CLI", (version) => {
    const res = runBeam(["--help"], { version });
    expect(res.status).toBe(0);
    const log = logLines();
    expect(log.some((l) => l.startsWith("EXEC:") && l.includes("cli/index.ts"))).toBe(true);
  });

  it("passes the version gate for canary.10 (numeric prerelease ordering)", () => {
    const res = runBeam(["--help"], { version: "1.4.0-canary.10" });
    expect(res.status).toBe(0);
  });

  it("passes argv through to the CLI after the wrapper cd's into the package root", () => {
    const res = runBeam(["dev", "--paper"], { version: "1.4.0" });
    expect(res.status).toBe(0);
    const log = logLines();
    const execLine = log.find((l) => l.startsWith("EXEC:"));
    expect(execLine).toBeDefined();
    expect(execLine).toContain("cli/index.ts");
    expect(execLine).toContain("dev --paper");
  });

  it("resolves the package root through a single-hop global-bin symlink", () => {
    const linkDir = mkdtempSync(path.join(sandbox, "link1-"));
    const link = path.join(linkDir, "beam");
    symlinkSync(BEAM_SH, link);
    const res = runBeam(["--help"], { script: link, version: "1.4.0" });
    expect(res.status).toBe(0);
    const log = logLines();
    expect(log).toContain(`BEAM_INSTALL_DIR=${realpathSync(REPO_ROOT)}`);
    expect(
      log.some(
        (l) => l.startsWith("EXEC:") && l.includes(`${realpathSync(REPO_ROOT)}/cli/index.ts`),
      ),
    ).toBe(true);
  });

  it("resolves the package root through a multi-hop relative symlink chain", () => {
    const chainDir = mkdtempSync(path.join(sandbox, "link3-"));
    const a = path.join(chainDir, "a");
    const b = path.join(chainDir, "b");
    symlinkSync("b", a); // relative target on purpose
    symlinkSync("c", b);
    symlinkSync(BEAM_SH, path.join(chainDir, "c"));
    const res = runBeam(["--version"], { script: a, version: "1.4.0" });
    expect(res.status).toBe(0);
    const log = logLines();
    expect(log).toContain(`BEAM_INSTALL_DIR=${realpathSync(REPO_ROOT)}`);
  });

  it("preserves the caller's cwd as BEAM_CALLER_CWD", () => {
    const caller = mkdtempSync(path.join(sandbox, "cwd-"));
    const res = runBeam(["--help"], { cwd: caller, version: "1.4.0" });
    expect(res.status).toBe(0);
    // bash reports PWD as the physical path (/private/var/... on macOS even
    // when the tmpdir API returned the /var/... alias).
    expect(logLines()).toContain(`BEAM_CALLER_CWD=${realpathSync(caller)}`);
  });

  // Regression for fnd_sig-feat-library-334b6b45bc-c771: the awk comparator
  // claimed to be prerelease-aware but compared labels as raw strings, so
  // canary.10 ordered BELOW canary.2. The comparator is extracted verbatim
  // from the script and exercised with semver-correct expectations.
  it("orders prerelease identifiers numerically (canary.10 > canary.2), not lexicographically", () => {
    const src = readFileSync(BEAM_SH, "utf8");
    const marker = `-v b="$MIN_BUN_VERSION"`;
    const start = src.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const quoteStart = src.indexOf("'", start);
    expect(quoteStart).toBeGreaterThan(-1);
    const quoteEnd = src.indexOf("'", quoteStart + 1);
    expect(quoteEnd).toBeGreaterThan(-1);
    const program = src.slice(quoteStart + 1, quoteEnd);

    const compare = (a: string, b: string): number => {
      try {
        execFileSync("awk", ["-v", `a=${a}`, "-v", `b=${b}`, program], { timeout: 10_000 });
        return 0; // a >= b passes the gate
      } catch (err) {
        // SAFETY: this branch only reads the documented subprocess exit status.
        const e = err as { status?: number };
        return e.status ?? 1;
      }
    };

    expect(compare("1.4.0-canary.10", "1.4.0-canary.2")).toBe(0); // 10 > 2 numerically
    expect(compare("1.4.0-canary.2", "1.4.0-canary.1")).toBe(0);
    expect(compare("1.4.0-canary.1", "1.4.0")).toBe(1); // prerelease < release
    expect(compare("1.3.9", "1.4.0-canary.1")).toBe(1);
    expect(compare("1.4.0", "1.4.0")).toBe(0);
  });
});
