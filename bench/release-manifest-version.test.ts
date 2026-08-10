// Contract tests for scripts/generate-release-manifest.ts, exercised as a real
// subprocess against temp fixture directories (the script is a thin CLI main
// over pure logic — exactly the shape finding 367e says to test via
// child-process invocation).
//
// Coverage map (clawpatch findings):
// - fnd_sig-feat-library-710c9f5545-6e96: VERSION must be validated with the
//   same regex as build-bundle.ts before any R2 key-path interpolation —
//   values like `../../evil` or `a/b` must be rejected (path traversal in the
//   R2 key namespace), not silently interpolated.
// - fnd_sig-feat-library-710c9f5545-367e: bundle filtering must handle valid
//   versions with `+` build metadata, skip bundles missing a .sha256, and
//   honor REQUIRE_ALL_BUNDLES (exit 1 on missing platforms, empty-bundle
//   warning when false).
// - fnd_sig-feat-library-710c9f5545-4ce4 / 334b6b45bc-8b03: every URL the
//   manifest advertises must correspond to an artifact the build step
//   actually produced — signature_url must be absent (or point at a real
//   .asc), never a guaranteed 404.
// - fnd_sig-feat-library-334b6b45bc-152c: version sources must agree —
//   pkg.version === latest CHANGELOG heading and manifest min_cli_version
//   <= pkg.version.
//
// FixScripts owns the script and package.json; these tests assert the
// corrected behavior.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_SCRIPT = path.join(REPO_ROOT, "scripts", "generate-release-manifest.ts");
const R2_BASE = "https://r2.test.example";
const PLATFORMS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

let sandbox: string;

beforeAll(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "release-manifest-test-"));
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

interface ManifestResult {
  status: number;
  stdout: string;
  stderr: string;
  manifest: Record<string, unknown> | null;
  dir: string;
}

function runManifest(
  opts: { version: string; files: string[]; requireAllBundles?: boolean },
): ManifestResult {
  const dir = mkdtempSync(path.join(sandbox, "run-"));
  for (const file of opts.files) {
    writeFileSync(path.join(dir, file), "fixture");
  }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    VERSION: opts.version,
    R2_BASE_URL: R2_BASE,
    OUT_FILE: "manifest.json",
  };
  if (opts.requireAllBundles !== undefined) {
    env.REQUIRE_ALL_BUNDLES = String(opts.requireAllBundles);
  }
  const res = spawnSync(process.execPath, [MANIFEST_SCRIPT], {
    cwd: dir,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  const status = res.status ?? 1;
  const stdout = String(res.stdout ?? "");
  const stderr = String(res.stderr ?? "");
  const manifestFile = path.join(dir, "manifest.json");
  const manifest = existsSync(manifestFile)
    ? (JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>)
    : null;
  return { status, stdout, stderr, manifest, dir };
}

function happyPathFiles(version: string): string[] {
  return [
    ...PLATFORMS.flatMap((p) => [`beam-v${version}-${p}.tar.gz`, `beam-v${version}-${p}.tar.gz.sha256`]),
    `beam-v${version}.tar.gz`,
    `beam-v${version}.tar.gz.sha256`,
  ];
}

describe("scripts/generate-release-manifest.ts — VERSION validation", () => {
  it.each(["../../evil", "a/b", "1.2.3/.."])("rejects path-traversal VERSION %s", (version) => {
    const res = runManifest({ version, files: [] });
    expect(res.status).not.toBe(0);
    expect(res.stderr.toLowerCase()).toContain("version");
  });

  it("rejects an empty VERSION", () => {
    const res = runManifest({ version: "", files: [] });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("VERSION env is required");
  });
});

describe("scripts/generate-release-manifest.ts — bundle filtering", () => {
  it("emits exactly the per-platform bundles with deterministic R2 URLs", () => {
    const res = runManifest({ version: "1.2.3", files: happyPathFiles("1.2.3") });
    expect(res.status).toBe(0);
    const m = res.manifest!;
    expect(m.version).toBe("1.2.3");
    expect(m.channel).toBe("stable");
    const bundles = m.bundles as Record<string, { url: string; sha256_url: string }>;
    expect(Object.keys(bundles).sort()).toEqual([...PLATFORMS].sort());
    expect(bundles["linux-x64"]!.url).toBe(`${R2_BASE}/releases/v1.2.3/beam-v1.2.3-linux-x64.tar.gz`);
    expect(bundles["linux-x64"]!.sha256_url).toBe(
      `${R2_BASE}/releases/v1.2.3/beam-v1.2.3-linux-x64.tar.gz.sha256`,
    );
    expect(m.tarball_url).toBe(`${R2_BASE}/releases/v1.2.3/beam-v1.2.3.tar.gz`);
    expect(m.sha256_url).toBe(`${R2_BASE}/releases/v1.2.3/beam-v1.2.3.tar.gz.sha256`);
  });

  it("reconstructs platform keys correctly for `+` build metadata versions", () => {
    const version = "1.2.3+build.5";
    const res = runManifest({ version, files: happyPathFiles(version), requireAllBundles: false });
    expect(res.status).toBe(0);
    const bundles = res.manifest!.bundles as Record<string, { url: string }>;
    expect(bundles["linux-x64"]!.url).toBe(
      `${R2_BASE}/releases/v${version}/beam-v${version}-linux-x64.tar.gz`,
    );
  });

  it("skips bundles whose .sha256 is missing and warns", () => {
    const res = runManifest({
      version: "1.2.3",
      files: [
        "beam-v1.2.3-linux-x64.tar.gz", // bundle present, checksum missing -> skipped
        "beam-v1.2.3-darwin-arm64.tar.gz",
        "beam-v1.2.3-darwin-arm64.tar.gz.sha256",
      ],
      requireAllBundles: false,
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("Missing checksum");
    const bundles = res.manifest!.bundles as Record<string, unknown>;
    expect(Object.keys(bundles)).toEqual(["darwin-arm64"]);
  });

  it("exits 1 when REQUIRE_ALL_BUNDLES platforms are missing", () => {
    const res = runManifest({
      version: "1.2.3",
      files: ["beam-v1.2.3-linux-x64.tar.gz", "beam-v1.2.3-linux-x64.tar.gz.sha256"],
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Missing bundles");
  });

  it("writes an empty-bundles manifest (exit 0) when REQUIRE_ALL_BUNDLES=false", () => {
    const res = runManifest({ version: "1.2.3", files: [], requireAllBundles: false });
    expect(res.status).toBe(0);
    expect(res.manifest!.bundles).toEqual({});
    expect(res.stderr).toContain("No bundles found");
  });
});

describe("scripts/generate-release-manifest.ts — artifact correspondence", () => {
  it("every advertised URL maps to a file the build step produced", () => {
    const version = "1.2.3";
    const res = runManifest({ version, files: happyPathFiles(version) });
    expect(res.status).toBe(0);
    const m = res.manifest!;
    const advertised: Array<[string, string]> = [["tarball_url", String(m.tarball_url)]];
    if (m.sha256_url) advertised.push(["sha256_url", m.sha256_url as string]);
    if (m.signature_url) advertised.push(["signature_url", m.signature_url as string]);
    for (const bundle of Object.values(m.bundles as Record<string, { url: string; sha256_url: string }>)) {
      advertised.push(["bundle.url", bundle.url], ["bundle.sha256_url", bundle.sha256_url]);
    }
    for (const [key, url] of advertised) {
      const basename = url.split("/").pop()!;
      expect(
        existsSync(path.join(res.dir, basename)),
        `${key} advertises ${basename} but the build step produced no such file`,
      ).toBe(true);
    }
  });
});

describe("version-source consistency", () => {
  it("package.json version matches the latest CHANGELOG heading", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    const changelog = readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
    const heading = changelog.match(/^## \[([^\]]+)\]/m);
    expect(heading).not.toBeNull();
    expect(pkg.version).toBe(heading![1]);
  });

  it("manifest min_cli_version is satisfiable by the current package version", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    const res = runManifest({ version: pkg.version, files: happyPathFiles(pkg.version) });
    expect(res.status).toBe(0);
    const minCliVersion = String(res.manifest!.min_cli_version);
    expect(semver.gte(pkg.version, minCliVersion)).toBe(true);
  });
});
