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

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { readonly [key: string]: JsonValue };
type Bundle = { url: string; sha256_url?: string; signature_url?: string };
type BundleMap = Map<string, Bundle>;

function isJsonObject(value: JsonValue): value is JsonObject {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function parseJsonObject(text: string): JsonObject {
  // SAFETY: JSON.parse output is validated by isJsonObject before use.
  const parsed = JSON.parse(text) as JsonValue;
  if (!isJsonObject(parsed)) throw new Error("manifest must be a JSON object");
  return parsed;
}

function readBundles(value: JsonValue | undefined): BundleMap {
  if (value === undefined) throw new Error("manifest bundles are missing");
  if (!isJsonObject(value)) throw new Error("manifest bundles must be an object");
  const bundles = new Map<string, Bundle>();
  for (const [platform, raw] of Object.entries(value)) {
    if (!isJsonObject(raw) || Object.prototype.toString.call(raw.url) !== "[object String]") {
      throw new Error(`invalid bundle for ${platform}`);
    }
    const sha256Url = raw.sha256_url;
    const signatureUrl = raw.signature_url;
    if (
      sha256Url !== undefined &&
      Object.prototype.toString.call(sha256Url) !== "[object String]"
    ) {
      throw new Error(`invalid checksum URL for ${platform}`);
    }
    if (
      signatureUrl !== undefined &&
      Object.prototype.toString.call(signatureUrl) !== "[object String]"
    ) {
      throw new Error(`invalid signature URL for ${platform}`);
    }
    const bundle: Bundle = { url: readString(raw.url) };
    if (sha256Url !== undefined) bundle.sha256_url = readString(sha256Url);
    if (signatureUrl !== undefined) bundle.signature_url = readString(signatureUrl);
    bundles.set(platform, bundle);
  }
  return bundles;
}

function isStringJson(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function readString(value: JsonValue | undefined): string {
  if (!isStringJson(value)) {
    throw new Error("manifest field must be a string");
  }
  return value;
}

function readOptionalString(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  return readString(value);
}

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
  manifest: JsonObject | null;
  dir: string;
}

function runManifest(opts: {
  version: string;
  files: string[];
  requireAllBundles?: boolean;
}): ManifestResult {
  const dir = mkdtempSync(path.join(sandbox, "run-"));
  for (const file of opts.files) {
    writeFileSync(path.join(dir, file), "fixture");
  }
  // SAFETY: process.env is copied into a child-process environment and all test overrides are strings.
  const env = {
    ...process.env,
    VERSION: opts.version,
    R2_BASE_URL: R2_BASE,
    OUT_FILE: "manifest.json",
  } as NodeJS.ProcessEnv;
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
    ? parseJsonObject(readFileSync(manifestFile, "utf8"))
    : null;
  return { status, stdout, stderr, manifest, dir };
}

function happyPathFiles(version: string): string[] {
  return [
    ...PLATFORMS.flatMap((p) => [
      `beam-v${version}-${p}.tar.gz`,
      `beam-v${version}-${p}.tar.gz.sha256`,
    ]),
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
    const bundles = readBundles(m.bundles);
    expect(Array.from(bundles.keys()).sort()).toEqual([...PLATFORMS].sort());
    expect(bundles.get("linux-x64")!.url).toBe(
      `${R2_BASE}/releases/v1.2.3/beam-v1.2.3-linux-x64.tar.gz`,
    );
    expect(bundles.get("linux-x64")!.sha256_url).toBe(
      `${R2_BASE}/releases/v1.2.3/beam-v1.2.3-linux-x64.tar.gz.sha256`,
    );
    expect(m.tarball_url).toBe(`${R2_BASE}/releases/v1.2.3/beam-v1.2.3.tar.gz`);
    expect(m.sha256_url).toBe(`${R2_BASE}/releases/v1.2.3/beam-v1.2.3.tar.gz.sha256`);
  });

  it("reconstructs platform keys correctly for `+` build metadata versions", () => {
    const version = "1.2.3+build.5";
    const res = runManifest({ version, files: happyPathFiles(version), requireAllBundles: false });
    expect(res.status).toBe(0);
    const bundles = readBundles(res.manifest!.bundles);
    expect(bundles.get("linux-x64")!.url).toBe(
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
    const bundles = readBundles(res.manifest!.bundles);
    expect(Array.from(bundles.keys())).toEqual(["darwin-arm64"]);
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
    const advertised: Array<[string, string]> = [["tarball_url", readString(m.tarball_url)]];
    const sha256Url = readOptionalString(m.sha256_url);
    const signatureUrl = readOptionalString(m.signature_url);
    if (sha256Url !== undefined) advertised.push(["sha256_url", sha256Url]);
    if (signatureUrl !== undefined) advertised.push(["signature_url", signatureUrl]);
    for (const bundle of readBundles(m.bundles).values()) {
      expect(bundle.sha256_url).toBeDefined();
      advertised.push(["bundle.url", bundle.url], ["bundle.sha256_url", bundle.sha256_url!]);
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
    // SAFETY: package.json is repository-controlled and its version is validated below.
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    const changelog = readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
    const heading = changelog.match(/^## \[([^\]]+)\]/m);
    expect(heading).not.toBeNull();
    expect(pkg.version).toBe(heading![1]);
  });

  it("manifest min_cli_version is satisfiable by the current package version", () => {
    // SAFETY: package.json is repository-controlled and its version is validated below.
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    const res = runManifest({ version: pkg.version, files: happyPathFiles(pkg.version) });
    expect(res.status).toBe(0);
    const minCliVersion = readString(res.manifest!.min_cli_version);
    expect(semver.gte(pkg.version, minCliVersion)).toBe(true);
  });
});
