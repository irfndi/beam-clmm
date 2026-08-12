// Contract test for the `start` script and the CLI subcommand table.
//
// Coverage map (clawpatch findings):
// - fnd_sig-feat-release-775032a0f4-2208: `bun run start` resolves to
//   `cli/index.ts dev`; the entrypoint exists and the CLI help (exit 0)
//   advertises the `dev` subcommand.
// - fnd_sig-feat-release-775032a0f4-4e98: every package.json script value that
//   starts with `bun cli/` must reference a file that exists on disk, so a
//   moved/renamed entrypoint can never silently break the script table.
//
// The CLI help smoke runs the real `cli/index.ts` under Bun (process.execPath)
// so a command-table rename or entrypoint move fails the suite, not a release.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

type CliResult = { status: number; stdout: string; stderr: string };

function runCli(args: string[]): CliResult {
  try {
    const stdout = execFileSync(process.execPath, ["cli/index.ts", ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 180_000,
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

describe("package.json script table", () => {
  it("start runs the dev subcommand through the centralized CLI entry", () => {
    expect(pkg.scripts.start).toBe("bun $(bun scripts/cli-entry.mjs) dev");
  });

  it("every CLI-invoking script references a file that exists on disk", () => {
    // Scripts may reference the centralized entry (scripts/cli-entry.mjs) or
    // a direct entrypoint (cli/<file>.ts); both must exist so a moved or
    // renamed entrypoint can never silently break the script table.
    const referenced: string[] = [];
    for (const value of Object.values(pkg.scripts)) {
      for (const m of value.matchAll(/(?:^|\s|\(|\))(cli\/[\w-]+\.ts|scripts\/[\w-]+\.mjs)/g)) {
        referenced.push(m[1]!);
      }
    }
    expect(referenced.length).toBeGreaterThan(0);
    for (const rel of referenced) {
      expect(existsSync(path.join(REPO_ROOT, rel)), `script table references missing ${rel}`).toBe(
        true,
      );
    }
  });
});

describe("CLI start-script contract", () => {
  it("`cli/index.ts --help` exits 0 and advertises the dev command", () => {
    const res = runCli(["--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("dev");
    expect(res.stdout).toContain("Beam");
  });

  it("`cli/index.ts dev --help` exits 0 (dev subcommand registered with options)", () => {
    const res = runCli(["dev", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("dev");
  });
});
