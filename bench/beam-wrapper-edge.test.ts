// Edge-case contract tests for scripts/beam.sh not covered by the main
// beam-wrapper suite: missing-awk must not be misdiagnosed as "bun too old"
// (fnd_sig-feat-config-5b229d3aa3-2e5bc), a symlink cycle must hit the
// 40-hop error (fnd_sig-feat-config-5b229d3aa3-62124), and a broken install
// without cli/index.ts must fail fast with a clear message
// (fnd_sig-feat-cli-command-a6167e9072-_000242dde7).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BEAM_SH = path.join(REPO_ROOT, "scripts", "beam.sh");

let sandbox: string;
let stubDir: string;
let noHomeDir: string;

beforeAll(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "beam-wrapper-edge-"));
  stubDir = path.join(sandbox, "bin");
  mkdirSync(stubDir);
  noHomeDir = path.join(sandbox, "nohome");
  mkdirSync(noHomeDir);

  // bun stub: prints FAKE_BUN_VERSION for --version, otherwise succeeds
  // silently (the exec'd CLI path is never reached in these tests).
  writeFileSync(
    path.join(stubDir, "bun"),
    `#!/bin/bash
if [ "$1" = "--version" ]; then printf '%s\\n' "$FAKE_BUN_VERSION"; fi
exit 0
`,
    { mode: 0o755 },
  );
  // dirname/readlink shims so a PATH without /usr/bin still satisfies the
  // wrapper's root resolution (awk is absent from stubDir on both macOS and
  // Ubuntu, where /bin is a symlink to /usr/bin — so the awk test below can
  // use a PATH with no awk while still resolving these tools).
  writeFileSync(path.join(stubDir, "dirname"), '#!/bin/bash\nexec /usr/bin/dirname "$@"\n', { mode: 0o755 });
  writeFileSync(path.join(stubDir, "readlink"), '#!/bin/bash\nexec /usr/bin/readlink "$@"\n', { mode: 0o755 });
  // bash shim so a PATH of just stubDir (no /bin) can still launch the
  // wrapper: execFileSync("bash", ...) resolves bash via PATH, and stubDir
  // alone excludes awk on both platforms.
  writeFileSync(path.join(stubDir, "bash"), '#!/bin/bash\nexec /bin/bash "$@"\n', { mode: 0o755 });
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runBeam(
  args: string[],
  opts: { path?: string; home?: string; script?: string } = {},
): RunResult {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    FAKE_BUN_VERSION: "1.4.0",
    PATH: opts.path ?? `${stubDir}:/usr/bin:/bin`,
    HOME: opts.home ?? noHomeDir,
  };
  try {
    const stdout = execFileSync("bash", [opts.script ?? BEAM_SH, ...args], {
      env,
      encoding: "utf8",
      timeout: 30_000,
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

describe("scripts/beam.sh edge cases", () => {
  it("reports a missing awk as a missing-tool error, not 'bun too old'", () => {
    // PATH without awk: bun/dirname/readlink shimmed in stubDir, and the
    // wrapper's cd/pwd/echo/exec are bash builtins. Use stubDir alone (not
    // `:stubDir:/bin`) so awk stays absent on Ubuntu too, where /bin is a
    // symlink to /usr/bin and would otherwise make awk findable.
    const res = runBeam(["--help"], { path: `${stubDir}` });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("awk is required");
    expect(res.stderr).not.toContain("too old");
  });

  it("guards symlink resolution with the 40-hop cap", () => {
    // A true symlink cycle cannot be exec'd through bash on macOS (the kernel
    // caps symlink depth at SYMLOOP_MAX=32, below our 40-hop guard, so bash
    // fails with "Too many levels of symbolic links" before the script runs).
    // The guard's contract is therefore asserted statically: the wrapper must
    // carry the hop counter and the 40-hop error, and the peer beam-wrapper
    // suite exercises real (sub-32) symlink chains end to end.
    const src = readFileSync(BEAM_SH, "utf8");
    expect(src).toMatch(/hops=0/);
    expect(src).toMatch(/hops -lt 40/);
    expect(src).toContain("Too many symlink levels");
  });

  it("fails fast with a clear message when cli/index.ts is missing (broken install)", () => {
    const broken = mkdtempSync(path.join(sandbox, "broken-"));
    const scriptsDir = path.join(broken, "scripts");
    mkdirSync(scriptsDir);
    writeFileSync(path.join(scriptsDir, "beam.sh"), readFileSync(BEAM_SH, "utf8"));
    writeFileSync(
      path.join(broken, "package.json"),
      JSON.stringify({ engines: { bun: ">=1.4.0-canary.1" } }, null, 2),
    );
    const res = runBeam(["--help"], { script: path.join(scriptsDir, "beam.sh") });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("cli/index.ts not found");
    expect(res.stderr).toContain(path.join(broken, "cli", "index.ts"));
  });
});
